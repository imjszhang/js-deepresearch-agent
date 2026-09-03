import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractClaimNumbers,
  sha256Hex,
} from '../scripts/benchmark/claim-audit.mjs';
import {
  hitsPatterns,
  matchQueryBattery,
  sourceMatchesPolicy,
  registrableDomain,
} from '../scripts/benchmark/query-battery.mjs';
import { isWafOrErrorBody } from '../scripts/benchmark/source-policy.mjs';
import {
  auditAsOfCompliance,
  auditClaim,
  auditContractMaterialization,
  auditRelevanceIntegrity,
  auditQueryProvenance,
  auditStrategyRun,
  completeSlots,
  evaluateProcessContract,
  hasHardStop,
} from '../scripts/benchmark/strategy-effectiveness.mjs';

const QUERY = '截至2026年8月，llama.cpp、MLX 与 Ollama 在 Apple Silicon 上做本地 LLM 推理的官方定位、性能取舍与推荐用法是什么？';
const ZHIPU_QUERY = '全面研究智谱这家公司，决定上亿资金是否投资智谱';

const REPORT = `# Report

## Summary
llama.cpp 定位为跨平台底层引擎 [1.1]。
MLX 定位为 Apple 原生框架 [1.2]。
Ollama 定位为易用封装，并推荐给初学者 [1.3]。

## Key Findings
- llama.cpp 是一等公民并提供 Metal 后端 [1.1]。
- MLX 是 Apple 原生框架 [1.2]。
- Ollama 是易用封装 [1.3]。
- llama.cpp 吞吐约为 40 tok/s [1.1]。
- MLX 吞吐比 llama.cpp 快 30% [1.2]。
- Ollama 切换后端后快 20% [1.3]。
- 追求易用选 Ollama，追求性能用 mlx-lm，跨平台选 llama.cpp [1.3]。
`;

const OFFICIAL_BODIES = [
  {
    id: 's1',
    title: 'llama.cpp',
    url: 'https://github.com/ggml-org/llama.cpp',
    content: 'llama.cpp is a first-class Metal backend for local inference. Throughput is about 40 tok/s on Apple Silicon.',
    fetchStatus: 'ok',
    contentOrigin: 'fetched',
  },
  {
    id: 's2',
    title: 'MLX',
    url: 'https://github.com/ml-explore/mlx',
    content: 'MLX is Apple native on unified memory. Throughput is 30% faster than llama.cpp in official docs.',
    fetchStatus: 'ok',
    contentOrigin: 'fetched',
  },
  {
    id: 's3',
    title: 'Ollama',
    url: 'https://ollama.com',
    content: 'Ollama is a beginner-friendly local wrapper. Switching backends is 20% faster with mlx-lm.',
    fetchStatus: 'ok',
    contentOrigin: 'fetched',
  },
];

describe('relevance integrity', () => {
  it('fails when a relevance-rejected source is still counted as a body', () => {
    const audit = auditRelevanceIntegrity([{
      url: 'https://apps.microsoft.com/kakao',
      content: 'KakaoTalk messaging application body.',
      fetchStatus: 'ok',
      bodyQuality: 'read',
      relevanceDecision: { accepted: false, reasonCode: 'entity_mismatch' },
    }], {
      metrics: {
        relevance: {
          returnedCandidates: 2,
          siteRejected: 1,
          admittedCandidates: 1,
          rerankEvaluated: 1,
          rerankAccepted: 0,
          rerankRejected: 1,
        },
      },
    });
    assert.equal(audit.pass, false);
    assert.equal(audit.counts.rejectedSourceBodies, 1);
  });

  it('passes legacy artifacts without relevance telemetry', () => {
    assert.equal(auditRelevanceIntegrity(OFFICIAL_BODIES, {}).pass, true);
  });

  it('rejects rerank-below-threshold decisions without an evaluated score', () => {
    const audit = auditRelevanceIntegrity([{
      url: 'https://example.com/zhipu',
      relevanceDecisionByGap: {
        'gap-2': {
          accepted: false,
          reasonCode: 'rerank_below_threshold',
          rerankScore: null,
          gapId: 'gap-2',
        },
      },
    }], {});
    assert.equal(audit.pass, false);
    assert.equal(audit.checks.find((item) => item.id === 'no_unevaluated_rerank_rejection').pass, false);
  });
});

function findingsFrom(sources, query = QUERY) {
  return [{ question: query, sources }];
}

function appleInput(overrides = {}) {
  return {
    query: QUERY,
    strategy: 'focused',
    report: REPORT,
    findings: findingsFrom(OFFICIAL_BODIES),
    sources: OFFICIAL_BODIES,
    claims: [],
    passages: [],
    quality: { budget: { usage: { llmTokens: 40000, sourceReads: 6 } } },
    trace: [],
    meta: { createdAt: '2026-08-01T00:00:00.000Z', query: QUERY },
    usage: { llmTokens: 40000, sourceReads: 6 },
    ...overrides,
  };
}

describe('query battery', () => {
  it('matches the Apple Silicon comparison query as slots, not cells', () => {
    const battery = matchQueryBattery(QUERY);
    assert.equal(battery.id, 'apple-silicon-local-llm');
    assert.equal(battery.slots.length, 7);
    assert.equal(battery.subjects, undefined);
    assert.ok(battery.slots.every((slot) => slot.id && slot.patterns.length));
  });

  it('matches a Zhipu equity-investment query as slots, not a 3x3 matrix', () => {
    const battery = matchQueryBattery(ZHIPU_QUERY);
    assert.equal(battery.id, 'zhipu-equity-investment');
    assert.ok(battery.slots.length >= 10);
    assert.equal(battery.subjects, undefined);
    assert.equal(battery.aspects, undefined);
    assert.ok(battery.slots.some((slot) => slot.id === 'financials.revenue'));
    assert.ok(battery.slots.some((slot) => slot.id === 'disclosure.gaps'));
    const control = battery.slots.find((slot) => slot.id === 'company.control');
    assert.equal(hitsPatterns('The controlling shareholder and ownership structure', control.patterns), true);
    const gaps = battery.slots.find((slot) => slot.id === 'disclosure.gaps');
    assert.equal(hitsPatterns('## Caveats\n\nMissing official filings.', gaps.patterns), true);
    assert.deepEqual(battery.sourcePolicies.regulatory.map((entry) => entry.host).sort(), [
      'hkexnews.hk',
      'www.hkexnews.hk',
      'www1.hkexnews.hk',
    ].sort());
  });
});

describe('host policy', () => {
  const llamaOfficial = [{ host: 'github.com', pathPrefix: '/ggml-org/' }];

  it('accepts an official path prefix', () => {
    assert.equal(sourceMatchesPolicy('https://github.com/ggml-org/llama.cpp', llamaOfficial), true);
    assert.equal(sourceMatchesPolicy('https://github.com/ggml-org/', llamaOfficial), true);
  });

  it('rejects lookalike hosts and unrelated paths', () => {
    assert.equal(sourceMatchesPolicy('https://github.com.evil.example/ggml-org/llama.cpp', llamaOfficial), false);
    assert.equal(sourceMatchesPolicy('https://evil-github.com/ggml-org/llama.cpp', llamaOfficial), false);
    assert.equal(sourceMatchesPolicy('https://github.com/other/llama.cpp', llamaOfficial), false);
  });

  it('normalizes a single leading www without treating extra subdomains as equal', () => {
    assert.equal(sourceMatchesPolicy('https://www.hkexnews.hk/listedco/listconews', [{ host: 'hkexnews.hk' }]), true);
    assert.equal(sourceMatchesPolicy('https://hkexnews.hk/listedco/listconews', [{ host: 'www.hkexnews.hk' }]), true);
    assert.equal(sourceMatchesPolicy('https://news.hkexnews.hk/listedco/listconews', [{ host: 'hkexnews.hk' }]), false);
    assert.equal(sourceMatchesPolicy('https://www1.hkexnews.hk/app', [{ host: 'www1.hkexnews.hk' }]), true);
  });

  it('collapses registrable domains and counts independent hosts', () => {
    assert.equal(registrableDomain('news.example.com'), 'example.com');
    assert.equal(registrableDomain('www.example.com'), 'example.com');
    assert.equal(registrableDomain('a.example.com.cn'), 'example.com.cn');
    const domains = new Set(['a.example.com', 'b.other.com'].map((host) => registrableDomain(host)));
    assert.equal(domains.size, 2);
  });
});

describe('strategy audit', () => {
  it('checks the zero-evidence exploration tail ratio', () => {
    const base = {
      usage: { sourceReads: 1 },
      cost: { explorationTokens: 1000, llmTokens: 1000, sourceReads: 1 },
      quality: { budget: {}, metrics: { recovery: { blockedGaps: [] } } },
      reportIntegrity: { pass: true },
      provenance: { counts: { realBodies: 1, summaries: 0 } },
      slots: { applicable: false, slots: [] },
      contractMaterialization: { pass: true },
      labeledNarrative: 'summary',
      report: '# Report\n\n## Limitations\nNone.',
    };
    const pass = evaluateProcessContract('exploratory', {
      ...base,
      trace: [{ action: 'read', successfulBodies: 1, budgetAfter: { usage: { llmTokens: 800 } } }],
    });
    assert.equal(pass.checks.find((item) => item.id === 'no_zero_evidence_spin').pass, true);
    const fail = evaluateProcessContract('exploratory', {
      ...base,
      trace: [{ action: 'read', successfulBodies: 1, budgetAfter: { usage: { llmTokens: 500 } } }],
    });
    assert.equal(fail.checks.find((item) => item.id === 'no_zero_evidence_spin').pass, false);
  });
  it('does not treat an unbacked budget_exhausted string as a hard stop', () => {
    const quality = {
      stopReason: 'budget_exhausted',
      flags: ['budget_exhausted'],
      budget: {
        usage: { llmTokens: 40000, searchRequests: 8, sourceReads: 4 },
        limits: { llmTokens: 1000000, searchRequests: 0, sourceReads: 0 },
      },
    };
    assert.equal(hasHardStop(quality), false);
  });

  it('accepts a near-cap stop when the next required claim would exceed the cap', () => {
    assert.equal(hasHardStop({
      stopReason: 'budget_exhausted',
      budget: {
        controllerStopDetail: 'llm_hard_cap',
        controllerStopRequiredAmount: 600,
        usage: { explorationTokens: 999925 },
        limits: { llmTokens: 1000000 },
      },
    }), true);
  });

  it('audits required brief slots against materialized gaps', () => {
    const audit = auditContractMaterialization({
      requiredAnswerSlots: [
        { id: 'mlx', answerSlot: 'MLX' },
        { id: 'ollama', answerSlot: 'Ollama' },
      ],
    }, [{
      id: 'gap-slot-mlx',
      contractSlotId: 'mlx',
      answerSlot: 'MLX',
      requiredSlot: true,
    }]);
    assert.equal(audit.pass, false);
    assert.deepEqual(audit.missing, ['ollama']);
  });

  it('does not complete a slot from name-dropping when numbers or official hosts are required', () => {
    const report = `# Report

## Summary
llama.cpp、MLX 与 Ollama 都出现在本地推理讨论里，本文比较它们的官方定位与性能。

## Key Findings
- llama.cpp MLX Ollama 都支持 Apple Silicon 本地推理。
- llama.cpp 定位为跨平台底层引擎。
`;
    const audit = auditStrategyRun({
      ...appleInput({
        report,
        findings: findingsFrom([{ url: 'https://news.example.com/local-llm', snippet: 'llama.cpp MLX Ollama' }]),
        sources: [{ url: 'https://news.example.com/local-llm', snippet: 'llama.cpp MLX Ollama' }],
        usage: { llmTokens: 8000, sourceReads: 1 },
      }),
    });
    const byId = Object.fromEntries(audit.requiredSlotCompletion.slots.map((slot) => [slot.id, slot]));
    assert.equal(byId['llamacpp.positioning'].status !== 'completed', true);
    assert.equal(byId['mlx.performance'].status !== 'completed', true);
    assert.equal(audit.requiredSlotCompletion.pass, false);
    assert.equal(audit.slotCounts.total, audit.requiredSlotCompletion.slots.length);
    assert.ok(audit.slotCounts.required <= audit.slotCounts.total);
  });

  it('exposes structural invalid reasons instead of a bare invalid status', () => {
    const audit = auditStrategyRun({
      ...appleInput({
        report: '# Report\n\n## Summary\nllama.cpp is a backend [1.1].\n',
        passages: [{
          id: 'p1',
          sourceId: 's1',
          text: 'not in source',
          startChar: 0,
          endChar: 12,
          contentHash: 'abc',
        }],
        sources: [{
          id: 's1',
          url: 'https://github.com/ggml-org/llama.cpp',
          content: 'llama.cpp official body',
          fetchStatus: 'ok',
        }],
      }),
    });
    assert.equal(audit.status, 'invalid');
    assert.ok(audit.invalidReasons.includes('quote_offset_mismatch') || audit.invalidReasons.length > 0);
  });

  it('passes the quick process contract on snippet-only sources and zero reads', () => {
    const snippets = OFFICIAL_BODIES.map((source) => ({
      ...source,
      content: undefined,
      fetchStatus: undefined,
      contentOrigin: undefined,
      snippet: 'llama.cpp MLX Ollama official positioning',
    }));
    const audit = auditStrategyRun({
      ...appleInput({
        strategy: 'quick',
        findings: findingsFrom(snippets),
        sources: snippets,
        usage: { llmTokens: 5000, sourceReads: 0 },
        quality: { budget: { usage: { llmTokens: 5000, sourceReads: 0 } } },
      }),
    });
    assert.equal(audit.processContract.pass, true);
    assert.equal(audit.evidenceProvenance.counts.realBodies, 0);
    assert.equal(audit.status, 'not_ready');
  });

  it('fails the quick process contract when it counted bodies', () => {
    const audit = auditStrategyRun({
      ...appleInput({
        strategy: 'quick',
        usage: { llmTokens: 5000, sourceReads: 0 },
        quality: { budget: { usage: { llmTokens: 5000, sourceReads: 0 } } },
      }),
    });
    assert.equal(audit.processContract.pass, false);
    assert.ok(audit.processContract.checks.some((item) => item.id === 'no_body_class_evidence' && item.pass === false));
    assert.ok(audit.evidenceProvenance.counts.realBodies > 0);
  });

  it('fails focused with zero real bodies', () => {
    const snippets = OFFICIAL_BODIES.map((source) => ({
      url: source.url,
      title: source.title,
      snippet: source.content,
    }));
    const audit = auditStrategyRun({
      ...appleInput({
        findings: findingsFrom(snippets),
        sources: snippets,
        usage: { llmTokens: 12000, sourceReads: 0 },
      }),
    });
    assert.equal(audit.processContract.pass, false);
    assert.ok(audit.processContract.checks.some((item) => item.id === 'real_body_or_summary' && item.pass === false));
    assert.equal(audit.status, 'not_ready');
  });

  it('fails focused on empty bullets', () => {
    const audit = auditStrategyRun(appleInput({
      report: `${REPORT}\n\n## Extra\n-\n`,
    }));
    assert.equal(audit.reportIntegrity.pass, false);
    assert.ok(audit.reportIntegrity.checks.some((item) => item.id === 'no_empty_bullets' && item.pass === false));
    assert.equal(audit.status, 'not_ready');
  });

  it('fails focused when a required official slot cites only a random media host', () => {
    const media = [{
      id: 'media',
      title: 'Blog',
      url: 'https://news.example.com/llama-cpp',
      content: 'llama.cpp is a first-class Metal backend for local inference. Throughput is about 40 tok/s on Apple Silicon.',
      fetchStatus: 'ok',
      contentOrigin: 'fetched',
    }, OFFICIAL_BODIES[1], OFFICIAL_BODIES[2]];
    const report = REPORT.replaceAll('[1.1]', '[1.1]');
    const audit = auditStrategyRun(appleInput({
      report,
      findings: findingsFrom(media),
      sources: media,
    }));
    const positioning = audit.requiredSlotCompletion.slots.find((slot) => slot.id === 'llamacpp.positioning');
    assert.equal(positioning.status, 'blocked');
    assert.ok(positioning.checks.some((item) => item.id === 'source_policy' && item.pass === false));
    assert.equal(audit.requiredSlotCompletion.pass, false);
    assert.equal(audit.status, 'not_ready');
  });

  it('fails exploratory when a critical slot is missing even if the report is long and sources exist', () => {
    const report = `# Report

## Summary
${'llama.cpp 定位为跨平台底层引擎 [1.1]。这篇长报告重复说明本地推理背景。 '.repeat(8)}

## Key Findings
- llama.cpp 是一等公民并提供 Metal 后端 [1.1]。
- llama.cpp 吞吐约为 40 tok/s [1.1]。
`;
    const audit = auditStrategyRun(appleInput({
      strategy: 'exploratory',
      report,
      findings: findingsFrom([OFFICIAL_BODIES[0]]),
      sources: [OFFICIAL_BODIES[0]],
      usage: { llmTokens: 80000, sourceReads: 8 },
      quality: { budget: { usage: { llmTokens: 80000, sourceReads: 8 } } },
    }));
    assert.ok(report.length > 200);
    assert.ok(audit.requiredSlotCompletion.slots.some((slot) => slot.critical && slot.status === 'missing'));
    assert.ok(audit.processContract.checks.some((item) => item.id === 'critical_slots_not_missing' && item.pass === false));
    assert.equal(audit.status, 'not_ready');
  });

  it('ignores a stored supported verdict when mechanical checks fail', () => {
    const claims = [{
      id: 'c-wrong',
      kind: 'key_claim',
      text: 'MLX 吞吐比 llama.cpp 快 99% [1.2]',
      citationKeys: ['1.2'],
      evaluation: { verdict: 'supported', method: 'llm' },
    }];
    const report = REPORT.replace('快 30%', '快 99%');
    const audit = auditStrategyRun(appleInput({ claims, report }));
    const claim = audit.claimChecks.find((item) => item.text.includes('99%'));
    assert.equal(claim.numbers_match, false);
    assert.equal(audit.status, 'not_ready');
    assert.notEqual(audit.requiredSlotCompletion.slots.find((slot) => slot.id === 'mlx.performance').status, 'completed');
  });

  it('marks ready when focused satisfies the published Apple contract', () => {
    const audit = auditStrategyRun(appleInput());
    assert.equal(audit.batteryId, 'apple-silicon-local-llm');
    assert.equal(audit.reportIntegrity.pass, true);
    assert.equal(audit.citationIntegrity.pass, true);
    assert.equal(audit.requiredSlotCompletion.pass, true);
    assert.equal(audit.processContract.pass, true);
    assert.equal(audit.status, 'ready');
  });

  it('does not let supported rate or cache metrics change official status', () => {
    const audit = auditStrategyRun(appleInput({
      quality: {
        budget: { usage: { llmTokens: 40000, sourceReads: 6 } },
        metrics: {
          rates: { supportedRate: 0, supportedOrPartialRate: 0 },
          relevance: { cacheHits: 999, rerankCalls: 387 },
        },
      },
    }));
    assert.equal(audit.status, 'ready');
    assert.equal(audit.asOfCompliance.applicable, false);
    assert.equal(audit.asOfCompliance.reason, 'not_applicable');
  });

  it('fails an explicit asOf contract on post-cutoff key claims', () => {
    assert.equal(auditAsOfCompliance({}, []).applicable, false);
    const audit = auditStrategyRun(appleInput({
      brief: { asOf: { date: '2026-08-31' } },
      claims: [{
        kind: 'key_claim',
        text: 'llama.cpp 吞吐约为 40 tok/s [1.1]',
        citedSourceIds: ['s1'],
      }],
      sources: OFFICIAL_BODIES.map((source) => ({ ...source, publishedAt: '2026-09-10' })),
    }));
    assert.equal(audit.asOfCompliance.applicable, true);
    assert.equal(audit.asOfCompliance.pass, false);
    assert.equal(audit.status, 'not_ready');
  });
});

describe('mutation fixtures', () => {
  it('fails citation_resolved after a citation is deleted', () => {
    const audit = auditStrategyRun(appleInput({
      findings: findingsFrom([OFFICIAL_BODIES[1], OFFICIAL_BODIES[2]]),
      sources: [OFFICIAL_BODIES[1], OFFICIAL_BODIES[2]],
    }));
    assert.equal(audit.citationIntegrity.pass, false);
    assert.ok(audit.claimChecks.some((claim) => claim.citation_resolved === false || audit.citationIntegrity.counts.unresolved > 0));
    assert.equal(audit.status, 'invalid');
  });

  it('fails numbers_match when the claim number is changed but the body is not', () => {
    const claim = {
      id: 'c1',
      kind: 'key_claim',
      text: 'MLX 吞吐比 llama.cpp 快 77% [1.2]',
      citationKeys: ['1.2'],
    };
    const audited = auditClaim(claim, {
      citationMap: new Map([['1.2', { source: OFFICIAL_BODIES[1], sourceId: 's2' }]]),
      sources: OFFICIAL_BODIES,
      passages: [],
    });
    assert.equal(extractClaimNumbers(claim.text).some((item) => item.digits === '77'), true);
    assert.equal(audited.numbers_match, false);
  });

  it('is invalid when body text no longer matches a stored contentHash', () => {
    const original = OFFICIAL_BODIES[0].content;
    const audit = auditStrategyRun(appleInput({
      passages: [{
        id: 'p1',
        sourceId: 's1',
        text: 'tampered body text that is long enough',
        contentHash: sha256Hex(original),
        startChar: 0,
        endChar: original.length,
      }],
    }));
    assert.equal(audit.status, 'invalid');
  });

  it('does not count a Cloudflare WAF page as a real body', () => {
    const waf = [{
      id: 'waf',
      url: 'https://github.com/ggml-org/llama.cpp',
      content: 'Just a moment... Attention Required! Cloudflare enable JavaScript to continue.',
      fetchStatus: 'ok',
      contentOrigin: 'fetched',
    }];
    const audit = auditStrategyRun(appleInput({
      findings: findingsFrom(waf),
      sources: waf,
    }));
    assert.equal(audit.evidenceProvenance.counts.realBodies, 0);
    assert.ok(audit.evidenceProvenance.counts.wafRejected >= 1);
    assert.equal(audit.evidenceProvenance.pass, false);
    assert.equal(isWafOrErrorBody(waf[0].content, { fetchClaimedOk: true }), true);
  });

  it('fails freshness when a dated source is older than maxAgeDays', () => {
    const battery = matchQueryBattery(ZHIPU_QUERY);
    const slot = battery.slots.find((item) => item.id === 'market.price');
    const completed = completeSlots({
      battery: { ...battery, slots: [slot] },
      report: '# Report\n\n## Summary\n截至 2024-01-01 智谱股价 12.5 港元，市值 100 亿 [1.1]。\n',
      narrative: '截至 2024-01-01 智谱股价 12.5 港元，市值 100 亿 [1.1]。',
      claims: [{
        kind: 'key_claim',
        text: '截至 2024-01-01 智谱股价 12.5 港元，市值 100 亿 [1.1]',
        citationKeys: ['1.1'],
      }],
      sources: [{
        id: 'px',
        url: 'https://www.hkexnews.hk/price',
        content: 'Price 12.5 HKD. Market cap 100 亿 as of 2024-01-01.',
        publishedAt: '2024-01-01T00:00:00.000Z',
        fetchStatus: 'ok',
        contentOrigin: 'fetched',
      }],
      meta: { createdAt: '2026-08-01T00:00:00.000Z' },
      citationMap: new Map([['1.1', {
        source: { url: 'https://www.hkexnews.hk/price' },
        sourceId: 'px',
      }]]),
    });
    assert.equal(completed.slots[0].status, 'blocked');
    assert.ok(completed.slots[0].checks.some((item) => item.id === 'freshness' && item.pass === false));
  });

  it('does not treat two URLs on the same registrable domain as two independent domains', () => {
    const battery = {
      id: 'custom',
      sourcePolicies: {},
      slots: [{
        id: 'cash',
        required: true,
        critical: true,
        minSources: 2,
        minIndependentDomains: 2,
        patternMode: 'any',
        patterns: [/cash|现金/i],
        requiresNumbers: false,
        sourcePolicy: null,
        maxAgeDays: null,
      }],
    };
    const sources = [
      { id: 'a', url: 'https://news.example.com/a', content: 'cash 10', fetchStatus: 'ok', contentOrigin: 'fetched' },
      { id: 'b', url: 'https://www.example.com/b', content: 'cash 10', fetchStatus: 'ok', contentOrigin: 'fetched' },
    ];
    const completed = completeSlots({
      battery,
      report: '## Summary\n现金 cash runway remains 10 months [1.1] [1.2].\n',
      claims: [{ kind: 'key_claim', text: '现金 cash runway remains 10 months [1.1] [1.2]', citationKeys: ['1.1', '1.2'] }],
      sources,
      citationMap: new Map([
        ['1.1', { source: sources[0], sourceId: 'a' }],
        ['1.2', { source: sources[1], sourceId: 'b' }],
      ]),
    });
    assert.equal(completed.slots[0].checks.find((item) => item.id === 'independent_domains').pass, false);
    assert.equal(completed.slots[0].status !== 'completed', true);
  });

  it('rejects a fake official subdomain', () => {
    assert.equal(
      sourceMatchesPolicy('https://github.com.evil.example/ggml-org/llama.cpp', [
        { host: 'github.com', pathPrefix: '/ggml-org/' },
      ]),
      false,
    );
  });

  it('fails reportIntegrity on an empty bullet', () => {
    const audit = auditStrategyRun(appleInput({
      report: `# Report

## Summary
llama.cpp 定位为跨平台底层引擎 [1.1]。这篇补充文字用于超过最短叙事长度要求，避免和空列表项混淆。

## Key Findings
-
- MLX 定位为 Apple 原生框架 [1.2]。
`,
    }));
    assert.equal(audit.reportIntegrity.pass, false);
    assert.equal(audit.status, 'not_ready');
  });
});

describe('query provenance audit', () => {
  it('marks legacy traces as not applicable', () => {
    const audit = auditQueryProvenance([{ action: 'search', query: 'old run' }]);
    assert.equal(audit.applicable, false);
    assert.equal(audit.pass, true);
  });

  it('fails new runs that execute rule templates or missing origins', () => {
    const audit = auditQueryProvenance([
      { action: 'search', query: 'alpha primary source evidence', queryOrigin: 'llm_planner' },
      {
        action: 'search',
        query: 'beta',
        reasonCode: 'site_fallback_query',
        queryOrigin: 'user_query',
        siteFallbackOf: 'site:x.com beta',
      },
    ], { metrics: { queryProvenance: {} } });
    assert.equal(audit.applicable, true);
    assert.equal(audit.pass, false);
  });

  it('passes planner-authored site fallbacks', () => {
    const audit = auditQueryProvenance([
      { action: 'search', query: 'topic', queryOrigin: 'user_query' },
      {
        action: 'search',
        query: 'topic official',
        queryOrigin: 'llm_planner',
        reasonCode: 'site_fallback_query',
        siteFallbackOf: 'site:gov.cn topic',
      },
    ]);
    assert.equal(audit.applicable, true);
    assert.equal(audit.pass, true);
  });
});

describe('determinism', () => {
  it('returns byte-identical audit JSON for the same input', () => {
    const input = appleInput();
    const first = auditStrategyRun(input);
    const second = auditStrategyRun(input);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it('keeps hitsPatterns available for battery helpers', () => {
    assert.equal(hitsPatterns('llama.cpp official', [/llama\.cpp/i]), true);
  });
});
