#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadArtifacts } from './load-artifacts.mjs';
import { extractRunStats } from './extract-run-stats.mjs';
import { runBenchmark } from './run-benchmark.mjs';
import { requireInspectionMode, routeQualityCommand } from './quality-command-router.mjs';
import { parseArgs } from '../../src/cli-utils.mjs';
import { assertIsolatedOutput } from './quality/artifact-verification.mjs';

const isCliEntry = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

function readJsonFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const raw = buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE
    ? buffer.toString('utf16le') : buffer.toString('utf8');
  const payload = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Extract artifact must be a JSON result object.');
  }
  return payload;
}

function loadJsonArtifacts(filePath) {
  const payload = readJsonFile(filePath);
  for (const field of ['findings', 'sources', 'gaps', 'passages', 'claims', 'trace']) {
    if (payload[field] != null && !Array.isArray(payload[field])) throw new Error(`Extract artifact ${field} must be an array.`);
  }
  if (payload.report != null && typeof payload.report !== 'string') throw new Error('Extract artifact report must be a string.');
  const meta = payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta)
    ? payload.meta : {};
  // A standalone result is diagnostic input, not a manifest-backed session.
  // Never promote payload-supplied paths to a trusted, pinned artifact bundle.
  return {
    meta: {
      ...meta,
      query: meta.query ?? payload.query ?? null,
      strategy: meta.strategy ?? payload.strategy ?? null,
      createdAt: meta.createdAt ?? payload.createdAt ?? null,
    },
    report: payload.report ?? '',
    findings: payload.findings ?? [],
    sources: payload.sources ?? [],
    gaps: payload.gaps ?? [],
    passages: payload.passages ?? [],
    claims: payload.claims ?? [],
    quality: payload.quality ?? null,
    trace: payload.trace ?? [],
    brief: payload.brief ?? null,
    reportPlan: payload.reportPlan ?? null,
    citationRegistry: payload.citationRegistry ?? null,
    evidenceStore: payload.evidenceStore ?? null,
    workDir: null,
    artifactFile: path.resolve(filePath),
    recordedFields: Object.fromEntries(['findings', 'sources', 'passages', 'claims', 'trace', 'report'].map((field) => [field, payload[field] != null])),
  };
}

function formatValue(value) {
  return value === null || value === undefined ? 'n/a' : value;
}

function formatCost(run, field) {
  const value = run.cost[field];
  if (!Number.isFinite(value)) return 'n/a';
  const unknown = run.cost.unknownUsage?.[field]
    || (field === 'llmTokens' && run.cost.costIsLowerBound);
  return unknown ? `>= ${value} (total unknown)` : value;
}

function difference(value, baseline) {
  return Number.isFinite(value) && Number.isFinite(baseline) ? value - baseline : null;
}

function costDifference(run, baseline, field) {
  if (run.cost.unknownUsage?.[field] || baseline.cost.unknownUsage?.[field]
    || (field === 'llmTokens' && (run.cost.costIsLowerBound || baseline.cost.costIsLowerBound))) return null;
  return difference(run.cost[field], baseline.cost[field]);
}

export async function compareExtractArtifacts({ summarySessionDir, extractArtifactsPath, notes = [] }) {
  if (!summarySessionDir || !extractArtifactsPath) {
    throw new Error('Extract comparison requires a summary session directory and an extract result JSON file.');
  }
  const summaryArtifacts = loadArtifacts(summarySessionDir);
  const extractArtifacts = loadJsonArtifacts(extractArtifactsPath);
  const runs = [];
  for (const [label, artifacts] of [['summary', summaryArtifacts], ['extract', extractArtifacts]]) {
    const stats = extractRunStats(artifacts);
    if (artifacts.recordedFields) {
      stats.query = artifacts.meta.query;
      stats.strategy = artifacts.meta.strategy;
      for (const [field, count] of Object.entries({ sources: 'sourceCount', findings: 'findingCount', passages: 'passageCount', claims: 'claimCount', trace: 'traceSteps', report: 'reportChars' })) {
        if (!artifacts.recordedFields[field]) stats.counts[count] = null;
      }
      if (!artifacts.recordedFields.trace) stats.llmPurposes = {
        purposes: {}, sourceSummaryCalls: null, sourceAssessmentCalls: null, totalCompletedLlmCalls: null,
      };
    }
    const benchmark = await runBenchmark({ artifacts, llmEnabled: false });
    runs.push({ ...stats, strategyLabel: label, artifactFile: artifacts.artifactFile ?? null, benchmark });
  }
  const queries = [...new Set(runs.map((run) => run.query).filter(Boolean))];
  const warnings = [];
  if (queries.length > 1) warnings.push('Compared runs use different queries.');
  if (runs.some((run) => !run.query)) warnings.push('A compared run has no recorded query; query equivalence is unverified.');
  const baseline = runs[0];
  const extract = runs[1];
  return {
    schemaVersion: 2,
    origin: 'program_check',
    query: queries.length === 1 && runs.every((run) => run.query) ? queries[0] : null,
    comparedAt: new Date().toISOString(),
    notes,
    warnings,
    runs,
    modelAssessment: { origin: 'model_assessment', observed: false, modelThresholdsMet: null },
    modelThresholdsMet: null,
    deltas: {
      llmRequests: costDifference(extract, baseline, 'llmRequests'),
      llmTokens: costDifference(extract, baseline, 'llmTokens'),
      searchRequests: costDifference(extract, baseline, 'searchRequests'),
      sourceReads: costDifference(extract, baseline, 'sourceReads'),
      durationMs: difference(extract.durationMs, baseline.durationMs),
    },
  };
}

export function formatExtractComparisonMarkdown(comparison) {
  const lines = [
    '# Extract Mode Artifact Comparison',
    '',
    `- Query: ${comparison.query || '(unverified or mixed queries)'}`,
    `- Compared at: ${comparison.comparedAt}`,
    '',
    'This offline comparison reports recorded costs and artifact integrity. Independent model assessment was not run. A standalone JSON result has no verified manifest and remains incomplete.',
    '',
  ];
  if (comparison.warnings.length) {
    lines.push('## Warnings', '', ...comparison.warnings.map((warning) => `- ${warning}`), '');
  }
  if (comparison.notes.length) {
    lines.push('## Supplied notes', '', ...comparison.notes.map((note) => `- ${note}`), '');
  }
  lines.push(
    '## Recorded costs', '',
    '| Mode | Duration | Sources | LLM tokens | LLM requests | Source summary / assessment calls | Searches | Reads | Rerank |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const run of comparison.runs) {
    lines.push(`| ${run.strategyLabel} | ${run.durationLabel} | ${formatValue(run.counts.sourceCount)} | ${formatCost(run, 'llmTokens')} | ${formatCost(run, 'llmRequests')} | ${formatValue(run.llmPurposes.sourceSummaryCalls)} | ${formatCost(run, 'searchRequests')} | ${formatCost(run, 'sourceReads')} | ${formatCost(run, 'rerankRequests')} |`);
  }
  lines.push('', '## Artifact verification and model observation', '',
    '| Mode | Artifact verification | Model observed | Model thresholds met |',
    '| --- | --- | --- | --- |');
  for (const run of comparison.runs) {
    const { artifactVerification, modelAssessment } = run.benchmark;
    lines.push(`| ${run.strategyLabel} | ${artifactVerification.status} | ${modelAssessment.observed ? 'yes' : 'no'} | ${formatValue(modelAssessment.modelThresholdsMet)} |`);
  }
  lines.push('', '## Recorded deltas (extract minus summary)', '',
    'These deltas describe the supplied runs; they do not isolate the causal effect of extraction mode. Missing measurements remain n/a.', '');
  for (const [field, value] of Object.entries(comparison.deltas)) {
    lines.push(`- ${field}: ${formatValue(value)}`);
  }
  lines.push('', '## Recorded LLM purposes', '');
  for (const run of comparison.runs) {
    lines.push(`### ${run.strategyLabel}`, '');
    const purposes = Object.entries(run.llmPurposes.purposes).sort(([a], [b]) => a.localeCompare(b));
    if (purposes.length) lines.push(...purposes.map(([purpose, count]) => `- ${purpose}: ${count}`));
    else lines.push('No per-purpose calls are available in the supplied trace.');
    lines.push('');
  }
  lines.push('## Inputs', '');
  for (const run of comparison.runs) lines.push(`- ${run.strategyLabel}: ${run.artifactFile || run.workDir || 'n/a'}`);
  return `${lines.join('\n')}\n`;
}

export async function buildExtractComparison(options) {
  return formatExtractComparisonMarkdown(await compareExtractArtifacts(options));
}

export async function main(argv) {
  if (await routeQualityCommand(argv)) return;
  const { args, flags } = parseArgs(argv);
  if (!argv.length || flags.help || flags.h) {
    console.log('Usage: npm run benchmark:extract -- <summary-session-dir> <extract-result.json> [output.md]\n       npm run benchmark:extract -- <quality-subcommand> [flags]\nComparison is offline; JSON inputs remain unverified without a manifest.');
    return;
  }
  requireInspectionMode(flags);
  if (Object.keys(flags).some((key) => !['no-llm', 'output'].includes(key))) throw new Error('Unknown extract comparison flag.');
  if (args.length < 2 || args.length > 3) {
    throw new Error('Expected summary session directory, extract result JSON, and optional Markdown output.');
  }
  const [summarySessionDir, extractArtifactsPath, positionalOutput] = args;
  if (flags.output !== undefined && (typeof flags.output !== 'string' || !flags.output.trim())) throw new Error('--output requires a file path.');
  if (positionalOutput && flags.output) throw new Error('Use one comparison output path.');
  const outputPath = positionalOutput || flags.output;
  if (outputPath) {
    assertIsolatedOutput(outputPath, [summarySessionDir, extractArtifactsPath]);
  }
  const report = await buildExtractComparison({ summarySessionDir, extractArtifactsPath });
  if (outputPath) {
    fs.writeFileSync(outputPath, report, 'utf8');
    console.error(`Comparison written to ${outputPath}`);
  }
  console.log(report);
}

if (isCliEntry) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
