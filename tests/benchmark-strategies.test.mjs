import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { saveResearchToWorkDir } from 'js-deepresearch-engine';
import { compareStrategySessions } from '../scripts/benchmark/compare-strategies.mjs';
import {
  archiveResearchResult,
  createIntelStoreEngine,
  loadArtifactsByResearchId,
  resetIntelStoreEngine,
} from '../src/storage/intel-store.mjs';
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
  resetIntelStoreEngine();
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
    assert.ok(comparison.runs[0].audit);
    assert.ok(comparison.runs[1].audit);
    assert.equal(comparison.runs[0].effectiveness, comparison.runs[0].audit);
    const markdown = formatStrategyCompareMarkdown(comparison);
    assert.match(markdown, /Strategy Benchmark Comparison/);
    assert.match(markdown, /Strategy Audit/);
    assert.match(markdown, /ready|not_ready|invalid/);
    assert.doesNotMatch(markdown, /Narrative supported|Tokens \/ supported|Contract \|/);
    assert.match(formatStrategyCompareJson(comparison), /"strategyLabel": "exploratory"/);
  });

  it('audits promise-aware contracts for the three live strategies', async () => {
    const query = '截至2026年8月，llama.cpp、MLX 与 Ollama 在 Apple Silicon 上做本地 LLM 推理的官方定位、性能取舍与推荐用法是什么？';
    const report = `# Report

## Summary
llama.cpp 定位为跨平台底层引擎 [1.1]。MLX 定位为 Apple 原生框架 [1.2]。Ollama 定位为易用封装并推荐给初学者 [1.3]。

## Key Findings
- llama.cpp 是一等公民并提供 Metal 后端 [1.1]。
- MLX 是 Apple 原生框架 [1.2]。
- Ollama 是易用封装 [1.3]。
- llama.cpp 吞吐约为 40 tok/s [1.1]。
- MLX 吞吐比 llama.cpp 快 30% [1.2]。
- Ollama 切换后端后快 20% [1.3]。
- 追求易用选 Ollama，追求性能用 mlx-lm，跨平台选 llama.cpp [1.3]。
`;
    const officialBodies = [
      {
        title: 'llama.cpp',
        url: 'https://github.com/ggml-org/llama.cpp',
        content: 'llama.cpp is a first-class Metal backend for local inference. Throughput is about 40 tok/s on Apple Silicon.',
        fetchStatus: 'ok',
        contentOrigin: 'fetched',
      },
      {
        title: 'MLX',
        url: 'https://github.com/ml-explore/mlx',
        content: 'MLX is Apple native on unified memory. Throughput is 30% faster than llama.cpp in official docs.',
        fetchStatus: 'ok',
        contentOrigin: 'fetched',
      },
      {
        title: 'Ollama',
        url: 'https://ollama.com',
        content: 'Ollama is a beginner-friendly local wrapper. Switching backends is 20% faster with mlx-lm.',
        fetchStatus: 'ok',
        contentOrigin: 'fetched',
      },
    ];
    const snippets = officialBodies.map((source) => ({
      title: source.title,
      url: source.url,
      snippet: 'llama.cpp MLX Ollama official positioning',
    }));

    const quick = createFixture({
      strategy: 'quick',
      query,
      report,
      sources: snippets,
      findings: [{ question: query, sources: snippets }],
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
    assert.equal(comparison.runs[0].audit.batteryId, 'apple-silicon-local-llm');
    assert.equal(comparison.runs[0].audit.processContract.pass, true);
    assert.equal(comparison.runs[0].audit.status, 'not_ready');
    assert.equal(comparison.runs[0].audit.evidenceProvenance.counts.realBodies, 0);
    assert.equal(comparison.runs[1].audit.status, 'ready');
    assert.equal(comparison.runs[1].audit.processContract.pass, true);
    assert.ok(comparison.runs[1].audit.evidenceProvenance.counts.realBodies > 0);
    assert.equal(comparison.runs[2].audit.status, 'ready');
    assert.ok(comparison.runs[2].audit.requiredSlotCompletion.slots.some((slot) => slot.id === 'llamacpp.positioning'));
    const markdown = formatStrategyCompareMarkdown(comparison);
    assert.match(markdown, /ready/);
    assert.match(markdown, /not_ready/);
    assert.match(markdown, /Observable counts/);
    assert.match(markdown, /Slot matrix/);
    assert.match(markdown, /Where strategies differ/);
    assert.match(markdown, /llamacpp\.positioning/);
    assert.match(markdown, /Optional semantic analysis \(non-official\)/);
    assert.doesNotMatch(markdown, /Narrative supported|Tokens \/ supported|official supported rate/);
    assert.doesNotMatch(markdown, /Subject × aspect|cellRate/);
  });

  it('does not let a display label change process-contract strategy semantics', async () => {
    const query = 'SubjectA official status';
    const quick = createFixture({
      strategy: 'quick',
      query,
      report: '# Report\n\n## Summary\n\nSubjectA is documented in snippets only.\n',
      sources: [{ id: 's1', title: 'A', url: 'https://docs.example.com/a', snippet: 'SubjectA snippet', engine: 'searxng' }],
      findings: [{ question: query, sources: [{ title: 'A', url: 'https://docs.example.com/a', snippet: 'SubjectA snippet', engine: 'searxng' }] }],
      quality: {
        schemaVersion: 3,
        gate: 'pass',
        flags: [],
        budget: { usage: { llmTokens: 1000, searchRequests: 2, sourceReads: 0, rerankRequests: 0 }, unknown: {} },
      },
    });
    const focused = createFixture({
      strategy: 'focused',
      query,
      report: '# Report\n\n## Summary\n\nSubjectA is documented in official docs [1.1].\n',
      sources: [{
        id: 's1',
        title: 'A',
        url: 'https://docs.example.com/a',
        content: 'SubjectA publishes a first-party guide at docs.example.com that states production support began in 2026.',
        fetchStatus: 'ok',
        contentOrigin: 'fetched',
        engine: 'searxng',
      }],
      findings: [{
        question: query,
        sources: [{
          title: 'A',
          url: 'https://docs.example.com/a',
          content: 'SubjectA publishes a first-party guide at docs.example.com that states production support began in 2026.',
          fetchStatus: 'ok',
          contentOrigin: 'fetched',
          engine: 'searxng',
        }],
      }],
      quality: {
        schemaVersion: 3,
        gate: 'pass',
        flags: [],
        budget: { usage: { llmTokens: 8000, searchRequests: 3, sourceReads: 2, rerankRequests: 0 }, unknown: {} },
      },
    });

    const comparison = await compareStrategySessions({
      sessions: [`after-focused=${quick}`, `baseline-focused=${focused}`],
      llmEnabled: false,
    });

    assert.equal(comparison.runs[0].strategyLabel, 'after-focused');
    assert.equal(comparison.runs[0].displayLabel, 'after-focused');
    assert.equal(comparison.runs[0].audit.processContract.checks.find((item) => item.id === 'source_reads_zero')?.pass, true);
    assert.equal(comparison.runs[0].audit.processContract.checks.find((item) => item.id === 'source_reads_at_least_one'), undefined);
    assert.equal(comparison.runs[1].audit.processContract.checks.find((item) => item.id === 'source_reads_at_least_one')?.pass, true);
  });

  it('round-trips work_dir brief/gap support through Intel into benchmark audit', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy-roundtrip-'));
    tempDirs.push(cwd);
    const intelRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy-intel-'));
    tempDirs.push(intelRoot);
    const engine = createIntelStoreEngine({ baseDir: path.join(intelRoot, 'store') });
    const query = 'SubjectA official status at docs.example.com';
    const sharedBrief = {
      schemaVersion: 1,
      query,
      depth: 'focused',
      contractOrigin: 'planner',
      requiredAnswerSlots: [{
        id: 'status',
        answerSlot: 'status',
        question: 'What is SubjectA status?',
        evidenceCriteria: ['official document'],
        requiredSlot: true,
      }],
    };
    const sharedGaps = [{
      id: 'gap-2',
      question: 'What is SubjectA status?',
      status: 'verified',
      requiredSlot: true,
      evidenceCriteria: ['official document'],
      slotSupport: {
        verdict: 'supported',
        quote: 'SubjectA publishes a first-party guide at docs.example.com',
        method: 'llm',
        quoteAnchored: true,
      },
    }];
    const body = 'SubjectA publishes a first-party guide at docs.example.com that states production support began in 2026.';
    const focusedResult = {
      report: '# Report\n\n## Summary\n\nSubjectA is documented in official docs [1.1].\n\n## Key Findings\n\n- SubjectA production support began in 2026. [1.1]\n',
      brief: sharedBrief,
      gaps: sharedGaps,
      findings: [{
        question: query,
        sources: [{ title: 'A', url: 'https://docs.example.com/a', content: body, fetchStatus: 'ok', contentOrigin: 'fetched', engine: 'searxng' }],
      }],
      sources: [{
        id: 's1',
        title: 'A',
        url: 'https://docs.example.com/a',
        content: body,
        fetchStatus: 'ok',
        contentOrigin: 'fetched',
        engine: 'searxng',
      }],
      quality: {
        schemaVersion: 3,
        gate: 'pass',
        flags: [],
        budget: { usage: { llmTokens: 8000, searchRequests: 3, sourceReads: 2, rerankRequests: 0 }, stopReason: 'evidence_sufficient' },
      },
      trace: [{ step: 1, action: 'search', strategy: 'focused' }],
    };
    const quickResult = {
      ...focusedResult,
      brief: { ...sharedBrief, depth: 'quick' },
      gaps: [{ ...sharedGaps[0], status: 'open', slotSupport: null }],
      findings: [{ question: query, sources: [{ title: 'A', url: 'https://docs.example.com/a', snippet: 'SubjectA snippet', engine: 'searxng' }] }],
      sources: [{ id: 's1', title: 'A', url: 'https://docs.example.com/a', snippet: 'SubjectA snippet', engine: 'searxng' }],
      quality: {
        schemaVersion: 3,
        gate: 'pass',
        flags: [],
        budget: { usage: { llmTokens: 1000, searchRequests: 2, sourceReads: 0, rerankRequests: 0 }, stopReason: null },
      },
      report: '# Report\n\n## Summary\n\nSubjectA is documented in snippets only.\n\n## Key Findings\n\n- Snippet-only scan of SubjectA.\n',
    };

    const focusedArtifacts = saveResearchToWorkDir({
      settings: { research: { workDir: 'work_dir' } },
      strategy: 'focused',
      query,
      result: focusedResult,
      researchId: 'roundtrip-focused',
      cwd,
      date: new Date('2026-09-01T04:00:00.000Z'),
    });
    const quickArtifacts = saveResearchToWorkDir({
      settings: { research: { workDir: 'work_dir' } },
      strategy: 'quick',
      query,
      result: quickResult,
      researchId: 'roundtrip-quick',
      cwd,
      date: new Date('2026-09-01T04:01:00.000Z'),
    });

    archiveResearchResult({
      researchId: 'roundtrip-focused',
      query,
      strategy: 'focused',
      result: focusedResult,
      artifacts: focusedArtifacts,
      engine,
    });
    archiveResearchResult({
      researchId: 'roundtrip-quick',
      query,
      strategy: 'quick',
      result: quickResult,
      artifacts: quickArtifacts,
      engine,
    });

    const loaded = loadArtifactsByResearchId('roundtrip-focused', { engine });
    assert.equal(loaded.brief.contractOrigin, 'planner');
    assert.deepEqual(loaded.brief.requiredAnswerSlots[0].evidenceCriteria, ['official document']);
    assert.equal(loaded.gaps[0].slotSupport.verdict, 'supported');
    assert.equal(loaded.gaps[0].slotSupport.quoteAnchored, true);

    const comparison = await compareStrategySessions({
      researchIds: ['roundtrip-quick', 'roundtrip-focused'],
      engine,
      llmEnabled: false,
    });
    assert.equal(comparison.runs[0].audit.processContract.checks.find((item) => item.id === 'source_reads_zero')?.pass, true);
    assert.equal(comparison.runs[1].audit.processContract.checks.find((item) => item.id === 'source_reads_at_least_one')?.pass, true);
    assert.equal(resolveStrategyLabel(loaded), 'focused');
  });
});
