import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { compareStrategySessions } from '../scripts/benchmark/compare-strategies.mjs';
import {
  durationFromTrace,
  extractRunStats,
  formatDurationMs,
  resolveStrategyLabel,
} from '../scripts/benchmark/extract-run-stats.mjs';
import {
  formatStrategyCompareJson,
  formatStrategyCompareMarkdown,
} from '../scripts/benchmark/format-strategy-compare.mjs';
import {
  DEFAULT_STRATEGY_COMPARE_ORDER,
  applyStrategyPreset,
  parseStrategyList,
} from '../scripts/benchmark/strategy-presets.mjs';

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function createFixture({
  strategy = 'source-based',
  query = 'llm wiki',
  trace = [],
  quality = null,
  sources = [{ id: 's1', title: 'A', url: 'https://a', snippet: 'alpha', engine: 'searxng' }],
  findings = [{ question: 'q1', sources: [{ title: 'A', url: 'https://a', snippet: 'alpha', engine: 'searxng' }] }],
  report = '# Report\n\n## Summary\n\nClaim [1.1].\n',
  claims = [],
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy-benchmark-'));
  tempDirs.push(dir);

  const defaultQuality = {
    schemaVersion: 3,
    gate: 'pass',
    flags: [],
    budget: {
      usage: {
        llmRequests: 5,
        llmTokens: 12000,
        searchRequests: 3,
        sourceReads: 2,
        rerankRequests: 1,
        rerankTokens: 0,
        estimatedCost: 0,
      },
      unknown: { estimatedCost: true },
      stopReason: null,
    },
  };

  fs.writeFileSync(path.join(dir, 'report.md'), report, 'utf8');
  fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(findings, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify(sources, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    query,
    strategy,
    researchId: `test-${strategy}`,
    createdAt: '2026-07-13T05:00:00.000Z',
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'quality.json'), JSON.stringify(quality || defaultQuality, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'trace.json'), JSON.stringify(trace, null, 2), 'utf8');
  if (claims.length > 0) {
    fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify(claims, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'passages.json'), JSON.stringify([], null, 2), 'utf8');
  }

  return dir;
}

describe('strategy presets', () => {
  it('parses default strategy list', () => {
    const presets = parseStrategyList(undefined);
    assert.deepEqual(presets.map((preset) => preset.label), DEFAULT_STRATEGY_COMPARE_ORDER);
  });

  it('applies adaptive loop version to cloned settings', () => {
    const settings = { research: { strategy: 'source-based', adaptive: { maxSteps: 4 } } };
    const v2 = applyStrategyPreset(settings, { label: 'adaptive-v2', strategy: 'adaptive', loopVersion: 'v2' });
    assert.equal(v2.research.strategy, 'adaptive');
    assert.equal(v2.research.adaptive.loopVersion, 'v2');
    assert.equal(settings.research.strategy, 'source-based');
  });
});

describe('extract run stats', () => {
  it('labels adaptive v2 from trace reason code', () => {
    const dir = createFixture({
      strategy: 'adaptive',
      trace: [{ reasonCode: 'agent_loop_v2', createdAt: '2026-07-13T05:00:00.000Z' }],
    });
    const artifacts = {
      workDir: dir,
      meta: JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')),
      trace: JSON.parse(fs.readFileSync(path.join(dir, 'trace.json'), 'utf8')),
      quality: JSON.parse(fs.readFileSync(path.join(dir, 'quality.json'), 'utf8')),
      sources: [],
      findings: [],
      report: '',
    };
    assert.equal(resolveStrategyLabel(artifacts), 'adaptive-v2');
  });

  it('derives duration from trace timestamps', () => {
    const durationMs = durationFromTrace([
      { createdAt: '2026-07-13T05:00:00.000Z' },
      { createdAt: '2026-07-13T05:02:30.000Z' },
    ]);
    assert.equal(durationMs, 150000);
    assert.equal(formatDurationMs(durationMs), '2m 30s');
  });

  it('extracts cost and counts from quality budget', () => {
    const dir = createFixture({ strategy: 'source-based' });
    const artifacts = {
      workDir: dir,
      meta: JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')),
      quality: JSON.parse(fs.readFileSync(path.join(dir, 'quality.json'), 'utf8')),
      sources: JSON.parse(fs.readFileSync(path.join(dir, 'sources.json'), 'utf8')),
      findings: JSON.parse(fs.readFileSync(path.join(dir, 'findings.json'), 'utf8')),
      report: fs.readFileSync(path.join(dir, 'report.md'), 'utf8'),
      trace: [],
      claims: [],
      passages: [],
    };
    const stats = extractRunStats(artifacts, { wallClockDurationMs: 91000 });
    assert.equal(stats.strategyLabel, 'source-based');
    assert.equal(stats.durationMs, 91000);
    assert.equal(stats.cost.llmTokens, 12000);
    assert.equal(stats.counts.sourceCount, 1);
  });
});

describe('compare strategy sessions', () => {
  it('compares two offline sessions with deltas', async () => {
    const sourceBased = createFixture({
      strategy: 'source-based',
      quality: {
        schemaVersion: 3,
        gate: 'pass',
        flags: [],
        budget: { usage: { llmTokens: 20000, searchRequests: 6, sourceReads: 5, rerankRequests: 0 }, unknown: {} },
      },
      claims: [{
        id: 'c1',
        kind: 'key_claim',
        text: 'Claim A',
        evidence: [],
        evaluation: {
          verdict: 'supported',
          confidence: 0.9,
          method: 'rules',
          evaluatedAt: '2026-07-13T05:00:00.000Z',
          evaluationVersion: 2,
          evidenceCounts: { supported: 1, partiallySupported: 0, unsupported: 0, unverifiable: 0 },
        },
      }],
    });
    const adaptiveV2 = createFixture({
      strategy: 'adaptive',
      trace: [
        { reasonCode: 'agent_loop_v2', createdAt: '2026-07-13T05:00:00.000Z' },
        { createdAt: '2026-07-13T05:01:00.000Z' },
      ],
      quality: {
        schemaVersion: 3,
        gate: 'pass_with_warnings',
        flags: ['budget_exhausted'],
        budget: { usage: { llmTokens: 40000, searchRequests: 8, sourceReads: 4, rerankRequests: 8 }, unknown: {} },
      },
      claims: [{
        id: 'c2',
        kind: 'key_claim',
        text: 'Claim B',
        evidence: [],
        evaluation: {
          verdict: 'partially_supported',
          confidence: 0.5,
          method: 'rules',
          evaluatedAt: '2026-07-13T05:00:00.000Z',
          evaluationVersion: 2,
          evidenceCounts: { supported: 0, partiallySupported: 1, unsupported: 0, unverifiable: 0 },
        },
      }],
    });

    const comparison = await compareStrategySessions({
      sessions: [sourceBased, adaptiveV2],
      llmEnabled: false,
      wallClockByWorkDir: new Map([[sourceBased, 120000]]),
    });

    assert.equal(comparison.runs.length, 2);
    assert.equal(comparison.runs[0].strategyLabel, 'source-based');
    assert.equal(comparison.runs[1].strategyLabel, 'adaptive-v2');
    assert.equal(comparison.deltas[0].llmTokens, 20000);
    assert.match(formatStrategyCompareMarkdown(comparison), /Strategy Benchmark Comparison/);
    assert.match(formatStrategyCompareJson(comparison), /"strategyLabel": "adaptive-v2"/);
  });
});
