import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  registerContentFetchHandler,
  resetContentFetchHandlers,
} from '../src/research/content-resolver.mjs';
import { enrichFindings } from '../src/research/source-enricher.mjs';

afterEach(() => resetContentFetchHandlers());

describe('source enricher relevance gate', () => {
  it('rejects an unrelated body before source_assessment', async () => {
    let summaryCalls = 0;
    registerContentFetchHandler(async () => ({
      status: 'ok',
      title: 'Catholic manuscript list',
      content: 'This university archive contains church manuscripts and historical collections with no company research.',
    }));
    const [finding] = await enrichFindings([{
      gapId: 'gap-2',
      question: '智谱AI监管合规情况',
      sources: [{ url: 'https://guides.lib.cua.edu/list', title: 'Manuscripts' }],
    }], {
      query: '研究智谱AI',
      fetchMode: 'summary',
      maxUrlsPerIteration: 1,
      maxUrlsTotal: 1,
      maxContentChars: 8000,
      enrichConcurrency: 1,
      llm: { async complete() { summaryCalls += 1; return 'summary'; } },
      settings: { research: { focused: { fetchBackend: 'auto' } } },
      relevance: { enabled: true, entityGuard: true, bodyValidation: true, minRerankScore: 0.01 },
      relevanceGap: { id: 'gap-2', question: '智谱AI监管合规情况', requiredHosts: [] },
      entities: ['智谱AI', '智谱'],
      budget: { claim() {}, canClaim() { return true; } },
    });
    assert.equal(summaryCalls, 0);
    assert.equal(finding.sources[0].fetchStatus, 'irrelevant');
    assert.equal(finding.sources[0].bodyQuality, 'irrelevant');
    assert.equal(finding.sources[0].relevanceDecision.reasonCode, 'entity_mismatch');
  });

  it('summarizes a relevant body after the gate passes', async () => {
    let summaryCalls = 0;
    registerContentFetchHandler(async () => ({
      status: 'ok',
      title: '智谱AI合规公告',
      content: '智谱AI发布了有关算法备案、数据安全和监管合规工作的正式说明。',
    }));
    const [finding] = await enrichFindings([{
      gapId: 'gap-2',
      question: '智谱AI监管合规情况',
      sources: [{ url: 'https://example.com/zhipu', title: '智谱AI公告' }],
    }], {
      query: '研究智谱AI',
      fetchMode: 'summary',
      maxUrlsPerIteration: 1,
      maxUrlsTotal: 1,
      maxContentChars: 8000,
      enrichConcurrency: 1,
      llm: {
        async complete() {
          summaryCalls += 1;
          return JSON.stringify({
            summary: '相关摘要',
            readability: 'readable',
            contentKind: 'article',
            publisherType: 'official',
            firstParty: true,
            evidenceTier: 'other_primary',
            reason: 'relevant body',
          });
        },
      },
      settings: { research: { focused: { fetchBackend: 'auto' } } },
      relevance: { enabled: true, entityGuard: true, bodyValidation: true, minRerankScore: 0.01 },
      relevanceGap: { id: 'gap-2', question: '智谱AI监管合规情况', requiredHosts: [] },
      entities: ['智谱AI', '智谱'],
      budget: { claim() {}, canClaim() { return true; } },
    });
    assert.equal(summaryCalls, 1);
    assert.equal(finding.sources[0].fetchStatus, 'ok');
    assert.equal(finding.sources[0].summary, '相关摘要');
    assert.equal(finding.sources[0].assessment.readability, 'readable');
  });

  it('admits a body that matches a structured entity alias', async () => {
    registerContentFetchHandler(async () => ({
      status: 'ok',
      title: '北京智谱华章科技股份有限公司招股说明书',
      content: '北京智谱华章科技股份有限公司披露了股权结构、主要股东和融资安排。',
    }));
    const [finding] = await enrichFindings([{
      gapId: 'gap-equity',
      question: 'What is the ownership structure of Zhipu AI?',
      sources: [{ url: 'https://example.com/filing', title: '招股说明书' }],
    }], {
      query: '研究 Zhipu AI',
      fetchMode: 'full',
      maxUrlsPerIteration: 1,
      maxUrlsTotal: 1,
      maxContentChars: 8000,
      enrichConcurrency: 1,
      llm: null,
      settings: { research: { focused: { fetchBackend: 'auto' } } },
      relevance: { enabled: true, entityGuard: true, bodyValidation: true },
      relevanceGap: { id: 'gap-equity', question: 'What is the ownership structure of Zhipu AI?' },
      entities: ['Zhipu AI'],
      entityAliases: ['北京智谱华章科技股份有限公司'],
      budget: { claim() {}, canClaim() { return true; } },
    });
    assert.equal(finding.sources[0].fetchStatus, 'ok');
    assert.equal(
      finding.sources[0].relevanceDecision.matchedAlias,
      '北京智谱华章科技股份有限公司',
    );
  });

  it('fail-closes unreadable assessment JSON and does not treat it as a successful body', async () => {
    registerContentFetchHandler(async () => ({
      status: 'ok',
      title: '智谱AI合规公告',
      content: '智谱AI发布了有关算法备案、数据安全和监管合规工作的正式说明。',
    }));
    const [finding] = await enrichFindings([{
      gapId: 'gap-2',
      question: '智谱AI监管合规情况',
      sources: [{ url: 'https://example.com/zhipu', title: '智谱AI公告' }],
    }], {
      query: '研究智谱AI',
      fetchMode: 'summary',
      maxUrlsPerIteration: 1,
      maxUrlsTotal: 1,
      maxContentChars: 8000,
      enrichConcurrency: 1,
      llm: { async complete() { return 'not-json'; } },
      settings: { research: { focused: { fetchBackend: 'auto' } } },
      relevance: { enabled: true, entityGuard: true, bodyValidation: true, minRerankScore: 0.01 },
      relevanceGap: { id: 'gap-2', question: '智谱AI监管合规情况', requiredHosts: [] },
      entities: ['智谱AI', '智谱'],
      budget: { claim() {}, canClaim() { return true; } },
    });
    assert.equal(finding.sources[0].fetchStatus, 'failed');
    assert.equal(finding.sources[0].assessment.method, 'fail_closed');
  });
});
