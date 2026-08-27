import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchQueryBattery } from '../scripts/benchmark/query-battery.mjs';
import {
  evaluateStrategyContract,
  scoreCoverage,
  scoreEvidenceMix,
  scoreNarrativeQuality,
  scoreStrategyEffectiveness,
  scoreSubjectEvidence,
} from '../scripts/benchmark/strategy-effectiveness.mjs';

const QUERY = '截至2026年8月，llama.cpp、MLX 与 Ollama 在 Apple Silicon 上做本地 LLM 推理的官方定位、性能取舍与推荐用法是什么？';

const REPORT = `# Report

## Summary
llama.cpp 定位为跨平台底层引擎 [1.1]。
MLX 是 Apple 原生框架 [1.2]。
Ollama 推荐给初学者，并切换到 MLX 后端 [1.3]。

## Key Findings

### 官方定位
- llama.cpp 是一等公民并提供 Metal 后端 [1.1]。
- MLX 是 Apple 原生框架 [1.2]。
- Ollama 是易用封装 [1.3]。

### 性能取舍
- MLX 吞吐比 llama.cpp 快 30% [1.2]。
- Ollama 切换后端后快 2 倍 [1.3]。

### 推荐用法
- 追求易用选 Ollama，追求性能用 mlx-lm，跨平台选 llama.cpp [1.3]。
`;

describe('query battery', () => {
  it('matches the Apple Silicon comparison query', () => {
    const battery = matchQueryBattery(QUERY);
    assert.equal(battery.id, 'apple-silicon-local-llm');
    assert.equal(battery.subjects.length, 3);
  });

  it('matches a Zhipu equity-investment query', () => {
    const battery = matchQueryBattery('全面研究智谱这家公司，决定上亿资金是否投资智谱');
    assert.equal(battery.id, 'zhipu-equity-investment');
    assert.equal(battery.subjects.length, 3);
    assert.equal(battery.aspects.length, 3);
  });
});

describe('strategy effectiveness', () => {
  it('scores subject and aspect coverage from the narrative', () => {
    const coverage = scoreCoverage(REPORT, matchQueryBattery(QUERY));
    assert.equal(coverage.subjectRate, 1);
    assert.equal(coverage.aspectRate, 1);
    assert.equal(coverage.cellRate, 1);
  });

  it('does not treat name-dropping as a full comparison', () => {
    const coverage = scoreCoverage(`# Report

## Summary
llama.cpp、MLX 与 Ollama 都出现在本地推理讨论里。

## Key Findings
- llama.cpp 定位为跨平台底层引擎。
`, matchQueryBattery(QUERY));
    assert.equal(coverage.subjectRate, 1);
    assert.ok(coverage.cellRate < 1);
  });

  it('requires a body or summary that mentions each subject', () => {
    const scored = scoreSubjectEvidence([
      { url: 'https://github.com/ggml-org/llama.cpp', content: 'llama.cpp Metal', fetchStatus: 'ok', contentOrigin: 'fetched' },
      { url: 'https://example.com/mlx', snippet: 'MLX only' },
    ], matchQueryBattery(QUERY));
    assert.equal(scored.subjectBodyRate, Number((1 / 3).toFixed(4)));
    assert.equal(scored.officialSubjectRate, Number((1 / 3).toFixed(4)));
  });

  it('treats snippets as the quick-mode evidence mix', () => {
    const mix = scoreEvidenceMix([], [
      { url: 'https://example.com/a', snippet: 'hello' },
      { url: 'https://github.com/ggml-org/llama.cpp', snippet: 'official' },
    ]);
    assert.equal(mix.bodySources, 0);
    assert.equal(mix.snippetSources, 2);
    assert.equal(mix.officialSources, 1);
  });

  it('counts only Summary and Key Findings as narrative claims', () => {
    const scored = scoreNarrativeQuality(`${REPORT}\n\n## Evidence\n- dump [1.1]\n`, QUERY, []);
    assert.ok(scored.metrics.keyClaimCount >= 3);
    assert.equal(scored.metrics.evidenceEntryCount, 0);
    assert.equal(scored.origin, 'extracted');
  });

  it('prefers stored key-claim verdicts over a fresh extract', () => {
    const scored = scoreNarrativeQuality(REPORT, QUERY, [{
      kind: 'key_claim',
      text: 'llama.cpp 定位为跨平台底层引擎',
      evaluation: { verdict: 'supported' },
    }]);
    assert.equal(scored.origin, 'stored_key_claims');
    assert.equal(scored.metrics.keyClaimCount, 1);
    assert.equal(scored.metrics.rates.supportedRate, 1);
  });

  it('passes exploratory when subjects, aspects, bodies, and claims are present', () => {
    const effect = scoreStrategyEffectiveness({
      query: QUERY,
      strategy: 'exploratory',
      report: REPORT,
      sources: [
        {
          url: 'https://github.com/ggml-org/llama.cpp',
          content: 'llama.cpp is a first-class Metal backend.',
          fetchStatus: 'ok',
          contentOrigin: 'fetched',
        },
        {
          url: 'https://github.com/ml-explore/mlx',
          content: 'MLX uses unified memory on Apple Silicon.',
          fetchStatus: 'ok',
          contentOrigin: 'fetched',
        },
        {
          url: 'https://ollama.com',
          content: 'Ollama is the beginner-friendly local runner.',
          fetchStatus: 'ok',
          contentOrigin: 'fetched',
        },
      ],
      usage: { llmTokens: 60000, sourceReads: 8 },
    });
    assert.equal(effect.contract.pass, true);
    assert.equal(effect.coverage.subjectRate, 1);
    assert.equal(effect.coverage.cellRate, 1);
    assert.equal(effect.evidence.subjectBodyRate, 1);
  });

  it('fails exploratory when the comparison matrix is mostly empty', () => {
    const effect = scoreStrategyEffectiveness({
      query: QUERY,
      strategy: 'exploratory',
      report: `# Report

## Summary
llama.cpp、MLX 与 Ollama 都出现在本地推理讨论里。

## Key Findings
- llama.cpp 定位为跨平台底层引擎。
`,
      sources: [
        { url: 'https://github.com/ggml-org/llama.cpp', content: 'llama.cpp', fetchStatus: 'ok', contentOrigin: 'fetched' },
        { url: 'https://github.com/ml-explore/mlx', content: 'MLX', fetchStatus: 'ok', contentOrigin: 'fetched' },
        { url: 'https://ollama.com', content: 'Ollama', fetchStatus: 'ok', contentOrigin: 'fetched' },
      ],
      usage: { llmTokens: 60000, sourceReads: 8 },
    });
    assert.equal(effect.contract.pass, false);
    assert.ok(effect.contract.checks.some((check) => check.id === 'covers_subject_aspects' && check.pass === false));
  });

  it('fails focused when it never reads a body or summary', () => {
    const contract = evaluateStrategyContract('focused', {
      mix: { bodySources: 0, summarySources: 0 },
      coverage: { subjectRate: 1, aspectRate: 1 },
      narrative: { metrics: { keyClaimCount: 4 } },
      usage: { sourceReads: 0 },
    });
    assert.equal(contract.pass, false);
    assert.ok(contract.checks.some((check) => check.id === 'reads_bodies' && check.pass === false));
  });

  it('passes quick when it stays snippet-first and names every subject', () => {
    const effect = scoreStrategyEffectiveness({
      query: QUERY,
      strategy: 'quick',
      report: REPORT,
      sources: [{ url: 'https://example.com', snippet: 'llama.cpp MLX Ollama' }],
      usage: { llmTokens: 5000, sourceReads: 0 },
    });
    assert.equal(effect.contract.pass, true);
    assert.equal(effect.evidence.bodySources, 0);
  });
});
