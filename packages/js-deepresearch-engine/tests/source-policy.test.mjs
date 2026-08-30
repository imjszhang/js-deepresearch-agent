import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifySourceTier,
  selectReadsByPolicy,
  buildSiteHostQueries,
  nextUnusedSiteQueries,
  registrableDomainFromUrl,
  shortSearchTerms,
  siteQueryTermVariants,
} from '../src/research/adaptive/source-policy.mjs';

describe('source policy before rerank', () => {
  it('ranks required hosts above media reprints and builds site queries', () => {
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
    assert.ok(buildSiteHostQueries(gap).some((query) => query.startsWith('site:hkexnews.hk')));
    assert.ok(!buildSiteHostQueries(gap, shortSearchTerms('智谱 02513')).some((query) => query.includes(gap.question)));
    assert.equal(registrableDomainFromUrl('https://www.news.example.com/a'), 'example.com');
  });

  it('retries empty site queries with a different short term instead of reusing the same host query', () => {
    const gap = {
      question: 'a very long unmatched gap about controlling shareholders and audited revenue',
      requiredHosts: ['hkexnews.hk'],
      preferredHosts: ['sse.com.cn'],
    };
    const first = nextUnusedSiteQueries(gap, '智谱 02513', [], { limit: 1 });
    assert.equal(first.length, 1);
    assert.match(first[0], /^site:hkexnews\.hk /);
    const retry = nextUnusedSiteQueries(gap, '智谱 02513', first, { limit: 1 });
    assert.equal(retry.length, 1);
    assert.notEqual(retry[0], first[0]);
    assert.ok(!retry[0].includes('sse.com.cn'));
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

  it('does not inject filing angles into official-docs queries', () => {
    const variants = siteQueryTermVariants('Compare official docs of llama.cpp and Ollama');
    assert.ok(!variants.some((item) => /年报|招股|prospectus|filing|公告/i.test(item)));
    const gap = { question: 'official docs', preferredHosts: ['hkexnews.hk', 'sec.gov'] };
    assert.deepEqual(nextUnusedSiteQueries(gap, 'official docs', []), []);
    assert.deepEqual(buildSiteHostQueries(gap), []);
  });
});
