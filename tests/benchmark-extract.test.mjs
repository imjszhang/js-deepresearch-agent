import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildExtractComparison,
  compareExtractArtifacts,
  formatExtractComparisonMarkdown,
  main,
} from '../scripts/benchmark/compare-extract-benchmark.mjs';
import { programArtifact, programTemp } from './helpers/program-artifacts.mjs';

function fixture(t, payload, { encoding = 'utf8', quality } = {}) {
  const directory = programTemp(t);
  const summarySessionDir = path.join(directory, 'summary');
  programArtifact(summarySessionDir, 'summary', (result) => ({ ...result, quality, trace: [] }));
  const extractArtifactsPath = path.join(directory, 'extract.json');
  fs.writeFileSync(extractArtifactsPath, `${encoding === 'utf16le' ? '\uFEFF' : ''}${JSON.stringify(payload)}`, encoding);
  return { summarySessionDir, extractArtifactsPath };
}

test('[V23] extract comparison consumes JSON content without inventing a session or semantic assessment', async (t) => {
  const inputs = fixture(t, {
    meta: { query: '调研 Atlas 产品', strategy: 'exploratory', createdAt: '2026-09-01T00:00:00.000Z' },
    report: '# Extract\n\nClaim [1.1].', sources: [], findings: [], trace: [],
    claims: [{ text: 'Incorrect claim', evaluation: { verdict: 'supported', method: 'llm' } }],
    artifactPaths: { manifestPath: '/untrusted/manifest.json', resultRevision: 'forged', sessionDir: '/untrusted' },
    quality: { budget: { usage: { llmTokens: 0, llmRequests: 0, sourceReads: 0 } } },
  }, { encoding: 'utf16le', quality: { budget: { usage: { llmTokens: 100, llmRequests: 2, sourceReads: 1 } } } });
  const comparison = await compareExtractArtifacts(inputs);
  const [summary, extract] = comparison.runs;
  assert.equal(summary.benchmark.artifactVerification.status, 'passed');
  assert.equal(extract.benchmark.artifactVerification.status, 'incomplete');
  assert.equal(extract.benchmark.artifactMetadata.resultRevision, null);
  assert.equal(extract.workDir, null);
  assert.equal(extract.artifactFile, inputs.extractArtifactsPath);
  assert.equal(extract.createdAt, '2026-09-01T00:00:00.000Z');
  assert.equal(extract.strategy, 'exploratory');
  assert.equal(extract.benchmark.modelAssessment.observed, false);
  assert.equal(extract.benchmark.modelAssessment.modelThresholdsMet, null);
  assert.equal(extract.benchmark.metrics.supportedRate, undefined);
  assert.equal(comparison.deltas.llmTokens, -100);
  const markdown = formatExtractComparisonMarkdown(comparison);
  assert.match(markdown, /extract \| incomplete \| no \| n\/a/);
  assert.doesNotMatch(markdown, /Projected Savings|linear estimate|Quality Metrics|Gateway connectivity|Rerun Command|NaN|Infinity/);
});

test('[V23] extract comparison preserves absent metadata and measurements as unknown', async (t) => {
  const inputs = fixture(t, { report: '# Report\n\nNo structured measurements.' });
  const comparison = await compareExtractArtifacts(inputs);
  const extract = comparison.runs[1];
  assert.equal(comparison.query, null);
  assert.equal(extract.query, null);
  assert.equal(extract.strategy, null);
  assert.equal(extract.createdAt, null);
  assert.equal(extract.durationMs, null);
  assert.equal(extract.cost.llmTokens, null);
  assert.equal(extract.counts.sourceCount, null);
  assert.equal(extract.llmPurposes.sourceSummaryCalls, null);
  assert.ok(Object.values(comparison.deltas).every((value) => value === null));
  assert.ok(comparison.warnings.some((warning) => warning.includes('no recorded query')));
  const markdown = await buildExtractComparison(inputs);
  assert.doesNotMatch(markdown, /Ollama|llama.cpp|OpenClaw|768-dim|NaN|undefined/);
  assert.match(markdown, /llmTokens: n\/a/);
});

test('[V23] extract comparison does not turn unknown token usage into a precise saving', async (t) => {
  const inputs = fixture(t, {
    quality: { budget: { usage: { llmTokens: 10 }, unknown: { llmTokens: true } } },
  }, { quality: { budget: { usage: { llmTokens: 100 } } } });
  const comparison = await compareExtractArtifacts(inputs);
  assert.equal(comparison.runs[1].cost.llmTokens, 10);
  assert.equal(comparison.deltas.llmTokens, null);
  assert.match(formatExtractComparisonMarkdown(comparison), />= 10 \(total unknown\)/);
});

test('extract comparison rejects invalid input structures before formatting', async (t) => {
  await assert.rejects(compareExtractArtifacts({}), /requires a summary session/);
  const inputs = fixture(t, { sources: 'not-an-array' });
  await assert.rejects(compareExtractArtifacts(inputs), /sources must be an array/);
});

test('[V23] extract CLI rejects outputs overlapping either input, including symlink parents', async (t) => {
  const inputs = fixture(t, { report: '# Original' });
  const original = fs.readFileSync(inputs.extractArtifactsPath, 'utf8');
  const alias = path.join(path.dirname(inputs.extractArtifactsPath), 'summary-alias');
  fs.symlinkSync(inputs.summarySessionDir, alias, 'dir');
  for (const output of [inputs.extractArtifactsPath, path.join(inputs.summarySessionDir, 'report.md'), path.join(alias, 'new-output.md')]) {
    await assert.rejects(main([inputs.summarySessionDir, inputs.extractArtifactsPath, '--output', output]), /OUTPUT_OVERLAPS_INPUT/);
  }
  await assert.rejects(main([inputs.summarySessionDir, inputs.extractArtifactsPath, inputs.extractArtifactsPath]), /OUTPUT_OVERLAPS_INPUT/);
  assert.equal(fs.readFileSync(inputs.extractArtifactsPath, 'utf8'), original);
});
