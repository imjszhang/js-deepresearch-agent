import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { buildCitationMap, parseCitations, resolveCitations } from '../scripts/benchmark/citations.mjs';
import { extractClaims } from '../scripts/benchmark/claims.mjs';
import { loadArtifacts, loadArtifactsByResearchId } from '../scripts/benchmark/load-artifacts.mjs';
import {
  archiveResearchResult,
  createIntelStoreEngine,
  resetIntelStoreEngine,
} from '../src/storage/intel-store.mjs';
import { scoreClaimRule, summarizeFindingsHealth } from '../scripts/benchmark/rule-score.mjs';
import { runBenchmark } from '../scripts/benchmark/run-benchmark.mjs';
import { resolveBenchmarkTarget } from '../scripts/benchmark/resolve-target.mjs';
import { formatJsonSummary, formatMarkdownSummary } from '../scripts/benchmark/format-output.mjs';
import { readArtifactManifest } from 'js-deepresearch-engine';
import { programArtifact } from './helpers/program-artifacts.mjs';

const tempDirs = [];

afterEach(() => {
  resetIntelStoreEngine();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function createFixture({
  report,
  findings,
  sources,
  meta = {
    query: 'llm wiki',
    strategy: 'source-based',
    researchId: 'test-id',
  },
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-'));
  tempDirs.push(dir);

  fs.writeFileSync(path.join(dir, 'report.md'), report, 'utf8');
  fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(findings, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify(sources, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  return dir;
}

describe('benchmark citations', () => {
  it('maps findings sources to citation keys', () => {
    const map = buildCitationMap([
      {
        question: 'q1',
        sources: [{ title: 'A', url: 'https://a', snippet: 'alpha', engine: 'js-eyes:zhihu' }],
      },
      {
        question: 'q2',
        sources: [
          { title: 'B1', url: 'https://b1', snippet: 'beta', engine: 'js-eyes:zhihu' },
          { title: 'B2', url: 'https://b2', snippet: 'gamma', engine: 'js-eyes:zhihu' },
        ],
      },
    ]);

    assert.equal(map.get('1.1')?.source.title, 'A');
    assert.equal(map.get('2.3'), undefined);
    assert.equal(map.get('2.2')?.source.title, 'B2');
  });

  it('parses and resolves citation markers from claim text', () => {
    const map = buildCitationMap([
      {
        question: 'q1',
        sources: [{ title: 'A', url: 'https://a', snippet: 'alpha', engine: 'js-eyes:zhihu' }],
      },
      {
        question: 'q2',
        sources: [
          { title: 'B1', url: 'https://b1', snippet: 'beta', engine: 'js-eyes:zhihu' },
          { title: 'B2', url: 'https://b2', snippet: 'gamma', engine: 'js-eyes:zhihu' },
          { title: 'B3', url: 'https://b3', snippet: 'delta', engine: 'js-eyes:zhihu' },
        ],
      },
    ]);

    const keys = parseCitations('Claim text [1.1][9.9] and again [1.1].');
    assert.deepEqual(keys, ['1.1', '9.9']);

    const rangeKeys = parseCitations('Range claim [6.1-6.3] and [2.1-2.2].');
    assert.deepEqual(rangeKeys, ['6.1', '6.2', '6.3', '2.1', '2.2']);

    const resolved = resolveCitations(keys, map);
    assert.deepEqual(resolved.unresolved, ['9.9']);
    assert.equal(resolved.resolved.length, 1);
  });
});

describe('benchmark claims', () => {
  it('extracts claims from Summary, Key Findings, and Evidence', () => {
    const claims = extractClaims(`# Report

## Summary

This is a summary claim without citation.

## Key Findings

1. **Finding one**: details [1.1].

## Evidence

- Evidence item [1.1].
`);

    assert.equal(claims.length, 3);
    assert.equal(claims[0].section, 'Summary');
    assert.match(claims[1].text, /Finding one/);
    assert.match(claims[2].text, /Evidence item/);
  });

  it('extracts claims from Chinese numbered reports with citations', () => {
    const claims = extractClaims(`# 报告

## 摘要

LLM Wiki 是一种个人知识库构建模式，核心是让 LLM 像编译器一样编译 Markdown Wiki。

## 1. 核心概念

### 1.1 定义

LLM Wiki 是提前编译知识，而非临时检索合成 [7.4]。Karpathy 将其定义为持久化产物 [2.1][5.1]。

## 8. 主要来源

- [1.1] 示例来源
`);

    assert.ok(claims.length >= 2);
    assert.equal(claims[0].section, '摘要');
    assert.match(claims[0].text, /LLM Wiki/);
    assert.match(claims.find((claim) => claim.section === '1.1 定义').text, /提前编译知识/);
    assert.equal(claims.some((claim) => claim.section === '8. 主要来源'), false);
  });
});

describe('benchmark rule scoring', () => {
  it('flags empty sources and failed findings', () => {
    const health = summarizeFindingsHealth(
      [{ question: 'q1', error: { message: 'failed' } }],
      [],
    );

    assert.deepEqual(health.flags.sort(), ['all_findings_failed', 'empty_sources', 'no_finding_sources']);
  });

  it('summarizes source enrichment health', () => {
    const health = summarizeFindingsHealth(
      [{ question: 'q1', sources: [{ title: 'A', url: 'https://a', snippet: 's' }] }],
      [
        { title: 'A', url: 'https://a', snippet: 's', fetchStatus: 'ok', content: 'full body' },
        { title: 'B', url: 'https://b', snippet: 's', fetchStatus: 'failed' },
      ],
    );

    assert.equal(health.enrichment.withContent, 1);
    assert.equal(health.enrichment.enrichOk, 1);
    assert.equal(health.enrichment.enrichFailed, 1);
    assert.equal(health.enrichment.enrichOkRate, 0.5);
  });

  it('flags missing citations and platform mismatch', () => {
    const map = buildCitationMap([
      {
        question: 'q1',
        sources: [{ title: 'Reddit post', url: 'https://r', snippet: 'reddit', engine: 'js-eyes:reddit' }],
      },
    ]);

    const noCitation = scoreClaimRule(
      { section: 'Summary', text: 'No citation here.' },
      map,
    );
    assert.ok(noCitation.flags.includes('no_citation'));

    const platformMismatch = scoreClaimRule(
      { section: 'Evidence', text: 'Claim [1.1].' },
      map,
      { strictPlatform: 'js-eyes:zhihu' },
    );
    assert.ok(platformMismatch.flags.includes('platform_mismatch'));
  });

  it('scores keyword overlap using summary and content evidence', () => {
    const map = buildCitationMap([
      {
        question: 'q1',
        sources: [{
          title: 'Wiki',
          url: 'https://a',
          snippet: 'short title only',
          summary: 'Karpathy LLM Wiki compiler-style RAG workflow',
          engine: 'js-eyes:zhihu',
        }],
      },
    ]);

    const scored = scoreClaimRule(
      { section: 'Summary', text: 'Karpathy LLM Wiki uses compiler-style RAG [1.1].' },
      map,
    );

    assert.ok(scored.keywordOverlap > 0.2);
    assert.equal(scored.flags.includes('low_keyword_overlap'), false);
  });
});

describe('runBenchmark', () => {
  it('defaults to offline artifact verification and never promotes stored verdicts or keyword overlap', async () => {
    const workDir = createFixture({
      report: '# Report\n\n## Summary\n\nExact matching stored text [1.1].',
      findings: [{ question: 'q', sources: [{ title: 'Exact matching stored text', url: 'https://a.test', content: 'Exact matching stored text' }] }],
      sources: [{ title: 'Exact matching stored text', url: 'https://a.test', content: 'Exact matching stored text', fetchStatus: 'ok' }],
    });
    for (const verdict of ['supported', 'unsupported']) {
      fs.writeFileSync(path.join(workDir, 'claims.json'), JSON.stringify([{ text: 'private stored claim', evaluation: { verdict, method: 'llm', confidence: 1 } }]));
      const result = await runBenchmark({ workDir });
      assert.equal(result.schemaVersion, 2);
      assert.equal(result.origin, 'program_check');
      assert.equal(result.artifactVerification.status, 'incomplete');
      assert.equal(result.artifactVerification.reason, 'VERSIONED_MANIFEST_UNAVAILABLE');
      assert.equal(result.evaluation.llmInvoked, false);
      assert.equal(result.evaluation.usedStoredLlm, false);
      assert.equal(result.evaluation.usedStoredRule, false);
      assert.deepEqual(result.modelAssessment, { origin: 'model_assessment', observed: false, modelThresholdsMet: null, reason: 'MODEL_OBSERVATION_NOT_REQUESTED' });
      assert.equal(result.metrics.sourceCount, 1);
      assert.equal(result.metrics.citationResolutionRate, null);
      assert.equal(result.metrics.contentPresenceRate, 1);
      assert.equal(result.metrics.claims, undefined);
      assert.equal(result.metrics.rates, undefined);
      assert.equal(result.claims, undefined);
      const json = formatJsonSummary(result);
      assert.equal(JSON.parse(json).schemaVersion, 2);
      assert.equal(json.includes('private stored claim'), false);
      assert.equal(json.includes('keywordOverlap'), false);
      assert.match(formatMarkdownSummary(result), /Semantic truth and extraction completeness: not verified/);
    }
  });

  it('rejects obsolete live judging before loading input or invoking a provider', async () => {
    let calls = 0;
    const llm = { complete: async () => { calls++; throw new Error('Must not run'); } };
    await assert.rejects(runBenchmark({ llmEnabled: true }), { code: 'BENCHMARK_MODEL_OBSERVATION_REQUIRED' });
    await assert.rejects(runBenchmark({ llm }), { code: 'BENCHMARK_MODEL_OBSERVATION_REQUIRED' });
    assert.equal(calls, 0);
  });

  it('checks versioned bodies and citation registry without semantic judgments', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-v2-'));
    tempDirs.push(directory);
    const first = programArtifact(directory);
    const result = await runBenchmark({ workDir: directory });
    assert.equal(result.artifactVerification.status, 'passed');
    assert.deepEqual(result.artifactVerification.resultPin, first.pin);
    assert.equal(result.metrics.documentVersionCount, 1);
    assert.equal(result.metrics.citationEntryCount, 1);
    assert.equal(result.metrics.reportCitationCount, 1);
    assert.equal(result.metrics.resolvedCitationCount, 1);
    assert.equal(result.metrics.citationResolutionRate, 1);
    assert.equal(result.modelAssessment.observed, false);
    assert.equal(result.modelAssessment.modelThresholdsMet, null);
  });

  it('does not fall back to root exports after a versioned artifact is corrupted', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-v2-corrupt-'));
    tempDirs.push(directory);
    const first = programArtifact(directory);
    const manifest = readArtifactManifest(directory, first.pin.manifestPath);
    fs.appendFileSync(manifest.reportPath, '\ncorruption');
    await assert.rejects(runBenchmark({ workDir: directory }), { code: 'BENCHMARK_ARTIFACT_INTEGRITY_INVALID' });
    assert.ok(fs.existsSync(path.join(directory, 'report.md')));
  });

  it('does not guess v2 citation coordinates from findings', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-v2-citation-'));
    tempDirs.push(directory);
    programArtifact(directory, 'unresolved', result => ({ ...result, citationRegistry: { schemaVersion: 1, entries: [] },
      findings: [{ sources: [{ title: 'Looks plausible', url: 'https://atlas.example.com/docs', content: 'Atlas provides a documented product' }] }] }));
    await assert.rejects(runBenchmark({ workDir: directory }), { code: 'BENCHMARK_ARTIFACT_INTEGRITY_INVALID' });
  });

  it('retains the manifest revision already loaded when the current pointer changes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-v2-fixed-'));
    tempDirs.push(directory);
    const first = programArtifact(directory, 'first');
    const artifacts = loadArtifacts(directory);
    programArtifact(directory, 'second', result => ({ ...result, report: result.report + '\nSecond revision.' }));
    const result = await runBenchmark({ artifacts });
    assert.equal(result.artifactMetadata.resultRevision, 'first');
    assert.deepEqual(result.artifactVerification.resultPin, first.pin);
    assert.equal(result.metrics.reportCharacterCount, artifacts.report.length);
  });

  it('treats bare JSON as unversioned input without interpreting its file path as a session', async () => {
    const result = await runBenchmark({ artifacts: { workDir: '/not/a/session/result.json', report: '# Report\n\nText [1.1].',
      executionVersion: 2, findings: [], sources: [], claims: [{ evaluation: { verdict: 'supported' } }] } });
    assert.equal(result.artifactVerification.status, 'incomplete');
    assert.equal(result.artifactVerification.reason, 'VERSIONED_MANIFEST_UNAVAILABLE');
    assert.equal(result.metrics.citationResolutionRate, null);
    assert.equal(result.modelAssessment.observed, false);
  });

  it('keeps unrecorded standalone fields unavailable instead of reporting zero or empty-source failures', async () => {
    const result = await runBenchmark({ artifacts: { report: '', sources: [], findings: [], passages: [],
      recordedFields: { report: false, sources: false, findings: false, passages: false } } });
    for (const field of ['sourceCount', 'sourceHostCount', 'passageCount', 'reportCharacterCount', 'reportCitationCount']) {
      assert.equal(result.metrics[field], null, field);
    }
    for (const field of ['sourceCount', 'findingCount', 'findingErrors', 'findingsWithSources']) assert.equal(result.artifactsHealth[field], null, field);
    assert.ok(Object.values(result.artifactsHealth.enrichment).every(value => value === null));
    assert.deepEqual(result.artifactsHealth.flags, []);
    const declaredEmpty = await runBenchmark({ artifacts: { report: '', sources: [], findings: [], passages: [],
      recordedFields: { report: true, sources: true, findings: true, passages: true } } });
    assert.equal(declaredEmpty.metrics.sourceCount, 0);
    assert.equal(declaredEmpty.metrics.passageCount, 0);
    assert.equal(declaredEmpty.metrics.reportCharacterCount, 0);
    assert.ok(declaredEmpty.artifactsHealth.flags.includes('empty_sources'));
  });

  it('compares all archived statistics with canonical fields while allowing compatibility-export normalization', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-v2-archive-stats-'));
    tempDirs.push(directory);
    const baseline = programArtifact(directory, 'stats', result => ({ ...result,
      sources: [{ id: result.citationRegistry.entries[0].sourceId, url: 'https://atlas.example.com/docs', title: 'Atlas' }],
      findings: [{ question: 'Atlas', sources: [] }], gaps: [{ id: 'gap-1' }], passages: [],
      claims: [{ id: 'claim-1', text: 'Saved claim' }],
      quality: { schemaVersion: 4, budget: { usage: { llmTokens: 1 }, reservations: [], settledAttemptIds: [] } },
      trace: [{ action: 'llm_call', status: 'completed', purpose: 'report', tokens: 1 }],
    }));
    const artifacts = readArtifactManifest(directory, baseline.pin.manifestPath);
    const engine = createIntelStoreEngine({ baseDir: path.join(directory, 'store') });
    const archive = (researchId, result) => archiveResearchResult({ researchId, query: 'Stats', strategy: 'focused', result, artifacts, engine });
    archive('unchanged', baseline.result);
    const unchanged = await runBenchmark({ researchId: 'unchanged', engine });
    assert.equal(unchanged.artifactVerification.status, 'passed');
    // claims.json adds placements/origin fields and report-plan.json has a
    // generated fallback; canonical snapshot equality must not compare those.
    assert.equal(unchanged.metrics.sourceCount, 1);
    const mutations = { sources: [{ id: 'other', url: 'https://other.example.com' }], findings: [],
      passages: [{ id: 'unexpected' }], claims: [], trace: [], quality: { budget: { usage: { llmTokens: 2 } } } };
    for (const [field, value] of Object.entries(mutations)) {
      const researchId = `changed-${field}`;
      archive(researchId, { ...baseline.result, [field]: value });
      await assert.rejects(runBenchmark({ researchId, engine }), { code: 'BENCHMARK_ARTIFACT_INTEGRITY_INVALID' }, field);
    }
    for (const field of ['sources', 'quality', 'trace']) {
      const incomplete = { ...baseline.result };
      delete incomplete[field];
      const researchId = `missing-${field}`;
      archive(researchId, incomplete);
      const checked = await runBenchmark({ researchId, engine });
      assert.equal(checked.artifactVerification.status, 'incomplete', field);
      assert.equal(checked.artifactVerification.reason, 'ARCHIVED_SNAPSHOT_FIELDS_UNAVAILABLE', field);
    }
  });

  it('pins archived research to its committed revision instead of the newer disk pointer', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-v2-archive-'));
    tempDirs.push(directory);
    const first = programArtifact(directory, 'archived');
    const artifacts = readArtifactManifest(directory, first.pin.manifestPath);
    const engine = createIntelStoreEngine({ baseDir: path.join(directory, 'store') });
    archiveResearchResult({ researchId: 'fixed-archive', query: 'fixed', strategy: 'focused', result: first.result, artifacts, engine });
    programArtifact(directory, 'later', result => ({ ...result, report: result.report + '\nLater revision.' }));
    const result = await runBenchmark({ researchId: 'fixed-archive', engine });
    assert.equal(result.artifactVerification.status, 'passed');
    assert.equal(result.artifactVerification.resultPin.resultRevision, first.pin.resultRevision);
    assert.equal(result.artifactVerification.resultPin.manifestHash, first.pin.manifestHash);
    assert.equal(fs.realpathSync(result.artifactVerification.resultPin.sessionDir), fs.realpathSync(first.pin.sessionDir));
    assert.equal(result.metrics.reportCharacterCount, first.result.report.length);
    archiveResearchResult({ researchId: 'unfixed-archive', query: 'unfixed', strategy: 'focused', result: first.result,
      artifacts: { sessionDir: directory, resultRevision: 'archived' }, engine });
    const incomplete = await runBenchmark({ researchId: 'unfixed-archive', engine });
    assert.equal(incomplete.artifactVerification.status, 'incomplete');
    assert.equal(incomplete.artifactVerification.reason, 'ARCHIVED_RESULT_PIN_UNAVAILABLE');
    archiveResearchResult({ researchId: 'changed-archive', query: 'changed', strategy: 'focused',
      result: { ...first.result, citationRegistry: { schemaVersion: 1, entries: [] } }, artifacts, engine });
    await assert.rejects(runBenchmark({ researchId: 'changed-archive', engine }), { code: 'BENCHMARK_ARTIFACT_INTEGRITY_INVALID' });
    archiveResearchResult({ researchId: 'missing-snapshot-evidence', query: 'missing', strategy: 'focused',
      result: { resultRevision: 'archived', report: first.result.report, findings: [], sources: [] }, artifacts, engine });
    const missingSnapshot = await runBenchmark({ researchId: 'missing-snapshot-evidence', engine });
    assert.equal(missingSnapshot.artifactVerification.status, 'incomplete');
    assert.equal(missingSnapshot.artifactVerification.reason, 'ARCHIVED_SNAPSHOT_EVIDENCE_UNAVAILABLE');
  });

  it('loads artifacts from disk', () => {
    const dir = createFixture({
      report: '# Report\n\n## Summary\n\nText.',
      findings: [],
      sources: [],
    });

    fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify({
      schemaVersion: 1,
      query: 'llm wiki',
      depth: 'focused',
      exclusions: ['forums'],
    }, null, 2), 'utf8');
    const artifacts = loadArtifacts(dir);
    assert.equal(artifacts.meta.query, 'llm wiki');
    assert.match(artifacts.report, /Summary/);
    assert.equal(artifacts.brief.schemaVersion, 1);
    assert.deepEqual(artifacts.brief.exclusions, ['forums']);
    assert.equal(artifacts.quality, null);
  });

  it('loads artifacts by researchId from intel store', async () => {
    const dir = createFixture({
      report: '# Report\n\n## Summary\n\nClaim [1.1].',
      findings: [{
        question: 'q1',
        sources: [{ title: 'A', url: 'https://a.test', snippet: 'alpha', engine: 'test' }],
      }],
      sources: [{ title: 'A', url: 'https://a.test', snippet: 'alpha', engine: 'test' }],
      meta: { query: 'intel load', strategy: 'source-based', researchId: 'bench-intel-1' },
    });

    const intelRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-intel-'));
    tempDirs.push(intelRoot);
    const engine = createIntelStoreEngine({ baseDir: path.join(intelRoot, 'store') });

    archiveResearchResult({
      researchId: 'bench-intel-1',
      query: 'intel load',
      strategy: 'source-based',
      result: {
        report: fs.readFileSync(path.join(dir, 'report.md'), 'utf8'),
        findings: JSON.parse(fs.readFileSync(path.join(dir, 'findings.json'), 'utf8')),
        sources: JSON.parse(fs.readFileSync(path.join(dir, 'sources.json'), 'utf8')),
      },
      artifacts: {
        sessionDir: dir,
        reportPath: path.join(dir, 'report.md'),
        findingsPath: path.join(dir, 'findings.json'),
        sourcesPath: path.join(dir, 'sources.json'),
        metaPath: path.join(dir, 'meta.json'),
      },
      engine,
    });

    const loaded = loadArtifactsByResearchId('bench-intel-1', { engine });
    assert.equal(loaded.meta.query, 'intel load');
    assert.match(loaded.report, /Claim \[1\.1\]/);

    const result = await runBenchmark({
      researchId: 'bench-intel-1',
      llmEnabled: false,
      engine,
    });
    assert.equal(result.metrics.reportCitationCount, 1);
    assert.equal(result.artifactVerification.status, 'incomplete');
    assert.equal(result.modelAssessment.observed, false);
  });
});

describe('benchmark CLI target resolution', () => {
  it('accepts work-dir or research-id exclusively', () => {
    assert.deepEqual(
      resolveBenchmarkTarget({ args: ['work_dir/run-1'], flags: {} }),
      { workDir: 'work_dir/run-1', researchId: null },
    );
    assert.deepEqual(
      resolveBenchmarkTarget({ args: [], flags: { 'research-id': 'run-abc' } }),
      { workDir: null, researchId: 'run-abc' },
    );
    assert.throws(
      () => resolveBenchmarkTarget({ args: ['work_dir/run-1'], flags: { 'research-id': 'run-abc' } }),
      /not both/,
    );
    assert.throws(
      () => resolveBenchmarkTarget({ args: [], flags: {} }),
      /Provide/,
    );
  });
});
