import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifySourceTier, independentBodyDomains, requiredHostQueries, selectReads } from '../src/research/adaptive/source-policy.mjs';
import { clusterCandidatesByOverlap } from '../src/research/adaptive/url-pool.mjs';

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

  it('does not drop different-host SERP hits as duplicates just because titles overlap', () => {
    const candidates = new Map([
      ['https://alpha-1.example/page', { id: 'https://alpha-1.example/page', url: 'https://alpha-1.example/page', title: 'alpha 1', status: 'unread', registrableDomain: 'alpha-1.example' }],
      ['https://alpha-2.example/page', { id: 'https://alpha-2.example/page', url: 'https://alpha-2.example/page', title: 'alpha 2', status: 'unread', registrableDomain: 'alpha-2.example' }],
      ['https://news.example.com/a', { id: 'https://news.example.com/a', url: 'https://news.example.com/a', title: 'Reprint', status: 'unread', registrableDomain: 'example.com' }],
      ['https://blog.example.com/b', { id: 'https://blog.example.com/b', url: 'https://blog.example.com/b', title: 'Reprint copy', status: 'unread', registrableDomain: 'example.com' }],
    ]);
    clusterCandidatesByOverlap(candidates);
    assert.equal(candidates.get('https://alpha-1.example/page').status, 'unread');
    assert.equal(candidates.get('https://alpha-2.example/page').status, 'unread');
    assert.equal(candidates.get('https://blog.example.com/b').status, 'duplicate');
  });
});
