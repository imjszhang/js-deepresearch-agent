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
  strategy = 'focused',
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

  it('applies a live strategy preset to cloned settings', () => {
    const settings = { research: { strategy: 'focused', exploratory: { maxSteps: 4 } } };
    const exploratory = applyStrategyPreset(settings, { label: 'exploratory', strategy: 'exploratory' });
    assert.equal(exploratory.research.strategy, 'exploratory');
    assert.equal(settings.research.strategy, 'focused');
  });
});

describe('extract run stats', () => {
  it('labels historical adaptive v2 as exploratory', () => {
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
    assert.equal(resolveStrategyLabel(artifacts), 'exploratory');
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
    const dir = createFixture({ strategy: 'focused' });
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
    assert.equal(stats.strategyLabel, 'focused');
    assert.equal(stats.durationMs, 91000);
    assert.equal(stats.cost.llmTokens, 12000);
    assert.equal(stats.actualLlmTokens, 12000);
    assert.equal(stats.counts.sourceCount, 1);
  });

  it('surfaces exploratory target tokens, stop reason, and unused budget', () => {
    const dir = createFixture({
      strategy: 'exploratory',
      quality: {
        schemaVersion: 3,
        gate: 'pass',
        flags: [],
        stopReason: 'evidence_sufficient',
        budget: {
          targetLlmTokens: 20000,
          unusedBudgetTokens: 8000,
          controllerStopReason: 'evidence_sufficient',
          usage: {
            llmRequests: 6,
            llmTokens: 12000,
            searchRequests: 2,
            sourceReads: 3,
            rerankRequests: 0,
            rerankTokens: 0,
            estimatedCost: 0,
          },
          unknown: { estimatedCost: true },
          stopReason: null,
        },
      },
    });
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
    const stats = extractRunStats(artifacts);
    assert.equal(stats.stopReason, 'evidence_sufficient');
    assert.equal(stats.targetLlmTokens, 20000);
    assert.equal(stats.actualLlmTokens, 12000);
    assert.equal(stats.unusedBudgetTokens, 8000);
    const markdown = formatStrategyCompareMarkdown({
      query: 'What is Ollama?',
      comparedAt: '2026-08-26T00:00:00.000Z',
      warnings: [],
      runs: [{
        ...stats,
        benchmark: {
          metrics: {
            rates: {
              supportedRate: null,
              partiallySupportedRate: null,
              unsupportedRate: null,
              unverifiableRate: null,
              evidenceCoverageRate: null,
              directEvidenceRate: null,
              keyClaimSupportedRate: null,
            },
          },
        },
      }],
      deltas: [],
    });
    assert.match(markdown, /min tokens: 20000/);
    assert.match(markdown, /actual tokens: 12000/);
    assert.match(markdown, /unused budget: 8000/);
    assert.match(markdown, /stop reason: evidence_sufficient/);
  });
});

describe('compare strategy sessions', () => {
  it('compares two offline sessions with deltas', async () => {
    const sourceBased = createFixture({
      strategy: 'focused',
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
    assert.equal(comparison.runs[0].strategyLabel, 'focused');
    assert.equal(comparison.runs[1].strategyLabel, 'exploratory');
    assert.equal(comparison.deltas[0].llmTokens, 20000);
    assert.ok(comparison.runs[0].effectiveness);
    assert.ok(comparison.runs[1].effectiveness);
    assert.match(formatStrategyCompareMarkdown(comparison), /Strategy Benchmark Comparison/);
    assert.match(formatStrategyCompareMarkdown(comparison), /Strategy Effectiveness/);
    assert.match(formatStrategyCompareJson(comparison), /"strategyLabel": "exploratory"/);
  });

  it('scores promise-aware contracts for the three live strategies', async () => {
    const query = '截至2026年8月，llama.cpp、MLX 与 Ollama 在 Apple Silicon 上做本地 LLM 推理的官方定位、性能取舍与推荐用法是什么？';
    const report = `# Report

## Summary
llama.cpp 定位为跨平台底层引擎 [1.1]。MLX 针对统一内存做了优化 [1.2]。Ollama 推荐给初学者 [1.3]。

## Key Findings

### 官方定位
- llama.cpp 是一等公民并提供 Metal 后端 [1.1]。

### 性能取舍
- MLX 吞吐比 llama.cpp 快 30% [1.2]。

### 推荐用法
- 追求易用选 Ollama，追求性能用 mlx-lm [1.3]。
`;
    const officialBodies = [
      {
        title: 'llama.cpp',
        url: 'https://github.com/ggml-org/llama.cpp',
        content: 'llama.cpp is a first-class Metal backend.',
        fetchStatus: 'ok',
        contentOrigin: 'fetched',
      },
      {
        title: 'MLX',
        url: 'https://github.com/ml-explore/mlx',
        content: 'MLX uses unified memory on Apple Silicon.',
        fetchStatus: 'ok',
        contentOrigin: 'fetched',
      },
      {
        title: 'Ollama',
        url: 'https://ollama.com',
        content: 'Ollama is the beginner-friendly local runner.',
        fetchStatus: 'ok',
        contentOrigin: 'fetched',
      },
    ];
    const snippet = {
      title: 'llama.cpp',
      url: 'https://github.com/ggml-org/llama.cpp',
      snippet: 'llama.cpp MLX Ollama official positioning',
    };

    const quick = createFixture({
      strategy: 'quick',
      query,
      report,
      sources: [snippet],
      findings: [{ question: query, sources: [snippet] }],
      quality: {
        schemaVersion: 3,
        gate: 'pass_with_warnings',
        flags: [],
        budget: { usage: { llmTokens: 5000, searchRequests: 3, sourceReads: 0, rerankRequests: 0 }, unknown: {} },
      },
    });
    const focused = createFixture({
      strategy: 'focused',
      query,
      report,
      sources: officialBodies,
      findings: [{ question: query, sources: officialBodies }],
      quality: {
        schemaVersion: 3,
        gate: 'pass',
        flags: [],
        budget: { usage: { llmTokens: 40000, searchRequests: 8, sourceReads: 6, rerankRequests: 0 }, unknown: {} },
      },
    });
    const exploratory = createFixture({
      strategy: 'exploratory',
      query,
      report,
      sources: officialBodies,
      findings: [{ question: query, sources: officialBodies }],
      quality: {
        schemaVersion: 3,
        gate: 'pass',
        flags: [],
        budget: { usage: { llmTokens: 70000, searchRequests: 10, sourceReads: 12, rerankRequests: 0 }, unknown: {} },
      },
    });

    const comparison = await compareStrategySessions({
      sessions: [`quick=${quick}`, `focused=${focused}`, `exploratory=${exploratory}`],
      llmEnabled: false,
    });

    assert.equal(comparison.runs.map((run) => run.strategyLabel).join(','), 'quick,focused,exploratory');
    assert.equal(comparison.runs[0].effectiveness.batteryId, 'apple-silicon-local-llm');
    assert.equal(comparison.runs[0].effectiveness.contract.pass, true);
    assert.equal(comparison.runs[1].effectiveness.contract.pass, true);
    assert.equal(comparison.runs[2].effectiveness.contract.pass, true);
    assert.equal(comparison.runs[0].effectiveness.evidence.bodySources, 0);
    assert.ok(comparison.runs[1].effectiveness.evidence.bodySources > 0);
    assert.equal(comparison.runs[2].effectiveness.coverage.subjectRate, 1);
    assert.ok(comparison.runs[2].effectiveness.coverage.cellRate >= 0.67);
    assert.match(formatStrategyCompareMarkdown(comparison), /Contract \|/);
  });
});
