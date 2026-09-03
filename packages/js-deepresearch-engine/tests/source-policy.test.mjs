import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  classifySourceTier,
  documentMatchesQuerySubject,
  evidenceIndependenceKey,
  evaluateSourceRelevance,
  independentEvidenceKeysFromSources,
  inferEvidenceScope,
  resolveEntityAliases,
  selectReadsByPolicy,
  registrableDomainFromUrl,
  queryMatchesGapScope,
  sourceMatchesSiteQuery,
  sourceMatchesEntities,
} from '../src/research/adaptive/source-policy.mjs';

const relevanceFixture = JSON.parse(readFileSync(
  new URL('./fixtures/relevance-serp.json', import.meta.url),
  'utf8',
));

describe('source policy before rerank', () => {
  it('ranks required hosts above media reprints', () => {
    const gap = {
      question: 'controlling shareholder and audited revenue',
      requiredHosts: ['hkexnews.hk'],
    };
    assert.equal(classifySourceTier({ url: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2025/a.htm' }, gap), 'required_primary');
    assert.equal(classifySourceTier({ url: 'https://finance.sina.com.cn/stock' }, gap), 'reprint');
    const picks = selectReadsByPolicy({
      candidates: [
        { id: 'media', url: 'https://finance.sina.com.cn/stock', title: 'Reprint', rerank: { score: 0.99 } },
        { id: 'filing', url: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2025/a.htm', title: 'Filing', rerank: { score: 0.1 } },
      ],
      gap,
      maxCount: 2,
    });
    assert.equal(picks[0].id, 'filing');
    assert.equal(picks[0].selectReason, 'required_host');
    assert.equal(registrableDomainFromUrl('https://www.news.example.com/a'), 'example.com');
  });

  it('does not drop file:// candidates when mixing them with web hosts', () => {
    const picks = selectReadsByPolicy({
      candidates: [
        { id: 'web-1', url: 'https://example.com/a', title: 'Web A', rerank: { score: 0.2 } },
        { id: 'local-1', url: 'file:///notes/a.md', title: 'Local A', corpusRoot: '/notes', engine: 'local:notes', rerank: { score: 0.9 } },
        { id: 'local-2', url: 'file:///notes/b.md', title: 'Local B', corpusRoot: '/notes', engine: 'local:notes', rerank: { score: 0.8 } },
        { id: 'local-3', url: 'file:///reports/c.md', title: 'Local C', corpusRoot: '/reports', engine: 'local:reports', rerank: { score: 0.1 } },
      ],
      maxPerHostname: 1,
      minCount: 1,
      maxCount: 4,
    });
    const ids = picks.map((item) => item.id);
    assert.ok(ids.includes('local-1') || ids.includes('local-3'));
    assert.ok(!ids.includes('local-1') || !ids.includes('local-2'));
    assert.equal(classifySourceTier({ url: 'file:///notes/a.md', title: 'Local notes' }), 'unknown');
  });

  it('counts local independence by corpus channel, not file count', () => {
    const sameCorpus = independentEvidenceKeysFromSources([
      { url: 'file:///notes/a.md', corpusRoot: '/notes', engine: 'local:notes' },
      { url: 'file:///notes/b.md', corpusRoot: '/notes', engine: 'local:notes' },
    ]);
    const twoCorpus = independentEvidenceKeysFromSources([
      { url: 'file:///notes/a.md', corpusRoot: '/notes', engine: 'local:notes' },
      { url: 'file:///reports/c.md', corpusRoot: '/reports', engine: 'local:reports' },
    ]);
    const mixed = independentEvidenceKeysFromSources([
      { url: 'file:///notes/a.md', corpusRoot: '/notes', engine: 'local:notes' },
      { url: 'https://example.com/page' },
    ]);
    assert.equal(sameCorpus.size, 1);
    assert.equal(twoCorpus.size, 2);
    assert.equal(mixed.size, 2);
    assert.notEqual(
      evidenceIndependenceKey({ url: 'file:///notes/a.md', corpusRoot: '/notes' }),
      evidenceIndependenceKey({ url: 'https://example.com/page' }),
    );
  });

  it('infers evidence scope from engine and corpus dirs', () => {
    assert.equal(inferEvidenceScope({ search: { engine: 'searxng' } }), 'web');
    assert.equal(inferEvidenceScope({ search: { engine: 'local', local: { dirs: ['/notes'] } } }), 'local');
    assert.equal(inferEvidenceScope({ search: { engine: 'searxng', local: { dirs: ['/notes'] } } }), 'mixed');
  });

  it('fails closed on site violations, entity mismatches, and low rerank scores', () => {
    const gap = { question: '智谱AI的监管合规情况', requiredHosts: [] };
    const relevant = {
      url: 'https://caixin.com/zhipu',
      title: '智谱AI监管合规进展',
      rerank: { provider: 'http', score: 0.42 },
    };
    assert.equal(sourceMatchesSiteQuery(relevant, 'site:caixin.com 智谱 监管'), true);
    assert.equal(sourceMatchesSiteQuery(relevant, 'site:zhipuai.cn 智谱 监管'), false);
    assert.equal(evaluateSourceRelevance(relevant, {
      gap,
      query: 'site:zhipuai.cn 智谱 监管',
      entities: ['智谱AI'],
      rerankProvider: 'http',
    }).reasonCode, 'site_constraint_violation');
    assert.equal(evaluateSourceRelevance({
      url: 'https://apps.microsoft.com/kakao',
      title: 'KakaoTalk for Windows',
      rerank: { provider: 'http', score: 0.004 },
    }, {
      gap,
      query: '智谱 监管',
      entities: ['智谱AI', '智谱'],
      rerankProvider: 'http',
    }).reasonCode, 'entity_mismatch');
    assert.equal(evaluateSourceRelevance({
      ...relevant,
      rerank: { provider: 'http', score: -0.12 },
    }, {
      gap,
      query: '智谱 监管',
      entities: ['智谱AI'],
      rerankProvider: 'http',
    }).reasonCode, 'rerank_below_threshold');
    assert.equal(sourceMatchesEntities({
      title: '智谱丨BigModel 平台',
      snippet: '智谱大模型开放平台',
    }, ['智谱AI', 'Zhipu AI']), true);
  });

  it('accepts an unevaluated rerank candidate without applying the threshold', () => {
    const decision = evaluateSourceRelevance({
      url: 'https://en.wikipedia.org/wiki/Zhipu_AI',
      title: '智谱AI',
      rerank: null,
    }, {
      gap: { question: '智谱AI公司信息' },
      query: '智谱AI 公司信息',
      entities: ['智谱AI'],
      rerankProvider: null,
      minRerankScore: 0.5,
    });
    assert.equal(decision.accepted, true);
    assert.equal(decision.rerankScore, null);
    assert.equal(decision.reasonCode, 'rerank_not_evaluated');
  });

  it('filters rejected candidates before authority and diversity ranking', () => {
    const picks = selectReadsByPolicy({
      candidates: [
        {
          id: 'irrelevant-edu',
          url: 'https://guides.lib.cua.edu/manuscripts',
          title: 'Manuscript collections',
          rerank: { provider: 'http', score: -0.126 },
        },
        {
          id: 'relevant-media',
          url: 'https://caixin.com/zhipu',
          title: '智谱AI监管合规进展',
          rerank: { provider: 'http', score: 0.42 },
        },
      ],
      gap: { question: '智谱AI监管情况' },
      relevance: {
        query: '智谱 监管',
        entities: ['智谱AI', '智谱'],
        rerankProvider: 'http',
        minRerankScore: 0.01,
      },
      minCount: 1,
      maxCount: 2,
    });
    assert.deepEqual(picks.map((item) => item.id), ['relevant-media']);
  });

  it('rejects every recorded off-topic SERP result before reading', () => {
    const decisions = relevanceFixture.results.map((source) => ({
      id: source.id,
      decision: evaluateSourceRelevance({
        ...source,
        rerank: { provider: 'http', score: source.rerankScore },
      }, {
        gap: { question: '智谱AI监管合规', requiredHosts: [] },
        query: relevanceFixture.query,
        entities: relevanceFixture.entities,
        rerankProvider: 'http',
      }),
    }));
    assert.equal(decisions.find((item) => item.id === 'official').decision.accepted, true);
    assert.deepEqual(
      decisions.filter((item) => item.id !== 'official').map((item) => item.decision.reasonCode),
      relevanceFixture.results.slice(1).map((item) => item.expected),
    );
  });

  it('validates query scope without rewriting the query', () => {
    assert.equal(queryMatchesGapScope('智谱AI 营收 利润 现金流', {
      question: '智谱AI的营收、利润及现金流状况如何?',
      claimFamily: 'financials',
    }, ['智谱AI']), true);
    assert.equal(queryMatchesGapScope('智谱AI 模型 专利 技术壁垒', {
      question: '智谱AI的营收、利润及现金流状况如何?',
      claimFamily: 'financials',
    }, ['智谱AI']), false);
  });

  it('uses the original research question when a slot is written in another language', () => {
    const englishSlot = {
      question: 'What was the monetary amount of the regulatory penalty imposed on 星河智算 in 2024?',
      answerSlot: 'penalty_amount',
      claimFamily: 'financial_penalty',
    };
    const researchQuery = '星河智算 2024 年监管处罚的金额、事由和整改措施是什么？';
    assert.equal(queryMatchesGapScope(
      '星河智算 2024 行政处罚 金额 事由 整改',
      englishSlot,
      ['星河智算'],
    ), false);
    assert.equal(queryMatchesGapScope(
      '星河智算 2024 行政处罚 金额 事由 整改',
      englishSlot,
      ['星河智算'],
      researchQuery,
    ), true);
    assert.equal(queryMatchesGapScope(
      '星河智算 模型 专利 技术壁垒',
      englishSlot,
      ['星河智算'],
      researchQuery,
    ), false);
  });

  it('keeps unevaluated external rerank candidates pending instead of auto-admitting them', () => {
    const decision = evaluateSourceRelevance({
      url: 'https://example.com/zhipu',
      title: '智谱AI',
    }, {
      gap: { question: '智谱AI公司信息' },
      query: '智谱AI 公司信息',
      entities: ['智谱AI'],
      rerankProvider: 'http',
      minRerankScore: 0.01,
    });
    assert.equal(decision.accepted, false);
    assert.equal(decision.reasonCode, 'rerank_pending');
  });

  it('does not strip OpenAI down to Open', () => {
    const aliases = resolveEntityAliases(['OpenAI', 'Zhipu AI']);
    assert.ok(aliases.includes('OpenAI'));
    assert.ok(!aliases.includes('Open'));
    assert.ok(aliases.includes('Zhipu'));
    assert.equal(sourceMatchesEntities({ title: 'OpenAI platform docs' }, ['OpenAI']), true);
  });

  it('accepts a Chinese filing when structured aliases match', () => {
    assert.equal(documentMatchesQuerySubject({
      title: '智谱AI 招股说明书',
      content: '智谱AI控股股东与营收披露。'.repeat(4),
    }, 'What is the ownership structure?', {
      entities: ['智谱AI'],
      entityAliases: ['Zhipu AI', '智谱'],
    }), true);
    assert.equal(documentMatchesQuerySubject({
      title: '思朗科技 年报',
      content: '思朗科技股份有限公司年度报告正文。'.repeat(4),
    }, 'What is the ownership structure?', {
      entities: ['智谱AI'],
      entityAliases: ['Zhipu AI'],
    }), false);
  });

  it('exposes the matched entity alias', () => {
    const decision = evaluateSourceRelevance({
      title: 'Zhipu AI platform',
      snippet: 'open platform',
    }, {
      entities: ['智谱AI'],
      entityAliases: ['Zhipu AI'],
      rerankProvider: null,
    });
    assert.equal(decision.accepted, true);
    assert.equal(decision.matchedAlias, 'Zhipu AI');
  });

  it('does not let authority tier admit a pending or below-threshold candidate', () => {
    const pending = selectReadsByPolicy({
      candidates: [{
        id: 'gov',
        url: 'https://www.sec.gov/filing',
        title: '智谱AI filing',
        snippet: '智谱AI',
        assessment: { evidenceTier: 'other_primary' },
      }],
      gap: { question: '智谱AI 股权', requiredHosts: [] },
      relevance: {
        query: '智谱AI 股权',
        entities: ['智谱AI'],
        rerankProvider: 'http',
        minRerankScore: 0.01,
      },
      minCount: 1,
      maxCount: 1,
    });
    assert.equal(pending.length, 0);
    const low = evaluateSourceRelevance({
      url: 'https://www.sec.gov/filing',
      title: '智谱AI filing',
      snippet: '智谱AI',
      rerank: { provider: 'http', score: 0.001 },
      assessment: { evidenceTier: 'other_primary' },
    }, {
      query: '智谱AI 股权',
      entities: ['智谱AI'],
      rerankProvider: 'http',
      minRerankScore: 0.01,
    });
    assert.equal(low.accepted, false);
    assert.equal(low.reasonCode, 'rerank_below_threshold');
  });
});
