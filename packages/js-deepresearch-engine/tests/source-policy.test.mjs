import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifySourceTier, independentBodyDomains, requiredHostQueries, selectReads } from '../src/research/adaptive/source-policy.mjs';

describe('source policy', () => {
  it('ranks required hosts and primary tiers before mainstream reprints', () => {
    const gap = { id: 'gap-1', question: 'filing revenue', requiredHosts: ['hkexnews.hk'] };
    const picks = selectReads({
      gap,
      count: 3,
      candidates: [
        { id: 'https://news.example/reprint', url: 'https://news.example/reprint', title: 'Media reprint' },
        { id: 'https://www.hkexnews.hk/ann', url: 'https://www.hkexnews.hk/ann', title: 'Annual report' },
        { id: 'https://github.com/org/proj', url: 'https://github.com/org/proj', title: 'Repo' },
      ],
    });
    assert.equal(picks[0].url, 'https://www.hkexnews.hk/ann');
    assert.equal(picks[0].tier, 'required_primary');
    assert.equal(classifySourceTier({ url: 'https://zhihu.com/p/1' }, gap), 'ugc');
  });

  it('builds site: queries for required hosts', () => {
    const queries = requiredHostQueries({
      question: '智谱 控股股东 年报',
      requiredHosts: ['hkexnews.hk'],
      searchedQueries: [],
    });
    assert.equal(queries[0], 'site:hkexnews.hk 智谱 控股股东 年报');
  });

  it('counts same-domain reprints as one independent source', () => {
    const domains = independentBodyDomains([
      { url: 'https://news.example.com/a' },
      { url: 'https://www.example.com/b' },
      { url: 'https://other.test/c' },
    ]);
    assert.equal(domains.size, 2);
    assert.ok(domains.has('example.com'));
    assert.ok(domains.has('other.test'));
  });
});
