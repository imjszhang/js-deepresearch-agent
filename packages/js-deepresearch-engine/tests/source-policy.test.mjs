import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifySourceTier,
  selectReadsByPolicy,
  buildSiteHostQueries,
  registrableDomainFromUrl,
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
    assert.equal(registrableDomainFromUrl('https://www.news.example.com/a'), 'example.com');
  });
});
