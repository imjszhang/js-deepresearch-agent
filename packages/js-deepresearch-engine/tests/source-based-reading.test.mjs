import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fetchUrlContent } from '../src/research/content-fetcher.mjs';
import { reportPrompt } from '../src/research/prompts.mjs';
import { formatSourcesForResearchContext } from '../src/research/source-context.mjs';
import { enrichFindings, enrichFindingSources } from '../src/research/source-enricher.mjs';
import { getSourceEvidence, resolveSourceBasedSettings } from '../src/research/source-based-settings.mjs';
import { filterFindingsByRelevance } from '../src/research/source-relevance-filter.mjs';
import { runSourceBasedPipeline } from '../src/research/strategies/source-based-pipeline.mjs';
import { runStrategy } from '../src/research/strategies.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockHtmlFetch(html) {
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => html,
  });
}

describe('source-based settings', () => {
  it('defaults fetchMode to disabled', () => {
    const resolved = resolveSourceBasedSettings({});
    assert.equal(resolved.fetchMode, 'disabled');
    assert.equal(resolved.maxUrlsTotal, 24);
  });

  it('prefers summary/content/snippet for evidence', () => {
    assert.equal(getSourceEvidence({ snippet: 's', content: 'c', summary: 'sum' }), 'sum');
    assert.equal(getSourceEvidence({ snippet: 's', content: 'c' }), 'c');
    assert.equal(getSourceEvidence({ snippet: 's' }), 's');
  });
});

describe('content fetcher', () => {
  it('extracts plain text from HTML', async () => {
    mockHtmlFetch('<html><head><title>Wiki</title></head><body><p>LLM wiki content</p></body></html>');
    const result = await fetchUrlContent('https://example.com/wiki');
    assert.equal(result.status, 'ok');
    assert.equal(result.title, 'Wiki');
    assert.match(result.content, /LLM wiki content/);
  });

  it('returns failed status for HTTP errors', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      headers: { get: () => 'text/html' },
      text: async () => '',
    });

    const result = await fetchUrlContent('https://example.com/missing');
    assert.equal(result.status, 'failed');
    assert.match(result.error, /404/);
  });
});

describe('source enricher', () => {
  it('returns findings unchanged when fetchMode is disabled', async () => {
    const findings = [{
      question: 'q1',
      sources: [{ title: 'A', url: 'https://a', snippet: 'alpha' }],
    }];

    const enriched = await enrichFindings(findings, {
      query: 'topic',
      fetchMode: 'disabled',
      maxUrlsPerIteration: 8,
      maxUrlsTotal: 24,
      maxContentChars: 8000,
      enrichConcurrency: 2,
      llm: { async complete() { throw new Error('should not call llm'); } },
    });

    assert.deepEqual(enriched, findings);
  });

  it('writes full content on successful fetch', async () => {
    mockHtmlFetch('<html><title>Article</title><body><p>Detailed LLM wiki article body.</p></body></html>');

    const [finding] = await enrichFindings([{
      question: 'llm wiki',
      sources: [{ title: 'Article', url: 'https://example.com/a', snippet: 'short' }],
    }], {
      query: 'llm wiki',
      fetchMode: 'full',
      maxUrlsPerIteration: 8,
      maxUrlsTotal: 24,
      maxContentChars: 8000,
      enrichConcurrency: 1,
      llm: { async complete() { throw new Error('should not call llm'); } },
    });

    assert.equal(finding.sources[0].fetchStatus, 'ok');
    assert.match(finding.sources[0].content, /Detailed LLM wiki article body/);
  });

  it('falls back to failed fetchStatus without throwing', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      headers: { get: () => 'text/html' },
      text: async () => '',
    });

    const [finding] = await enrichFindings([{
      question: 'q',
      sources: [{ title: 'A', url: 'https://example.com/a', snippet: 'keep snippet' }],
    }], {
      query: 'topic',
      fetchMode: 'full',
      maxUrlsPerIteration: 8,
      maxUrlsTotal: 24,
      maxContentChars: 8000,
      enrichConcurrency: 1,
      llm: { async complete() { throw new Error('should not call llm'); } },
    });

    assert.equal(finding.sources[0].fetchStatus, 'failed');
    assert.equal(finding.sources[0].snippet, 'keep snippet');
  });

  it('deduplicates URLs and respects caps', async () => {
    mockHtmlFetch('<html><title>T</title><body><p>Body text</p></body></html>');

    const sharedUrl = 'https://example.com/shared';
    const findings = [{
      question: 'q1',
      sources: [
        { title: 'A', url: sharedUrl, snippet: 'a' },
        { title: 'B', url: 'https://example.com/b', snippet: 'b' },
      ],
    }, {
      question: 'q2',
      sources: [
        { title: 'C', url: sharedUrl, snippet: 'c' },
        { title: 'D', url: 'https://example.com/d', snippet: 'd' },
      ],
    }];

    const enriched = await enrichFindings(findings, {
      query: 'topic',
      fetchMode: 'full',
      maxUrlsPerIteration: 1,
      maxUrlsTotal: 2,
      maxContentChars: 8000,
      enrichConcurrency: 1,
      llm: { async complete() { throw new Error('should not call llm'); } },
    });

    const okCount = enriched.flatMap((finding) => finding.sources)
      .filter((source) => source.fetchStatus === 'ok').length;
    assert.equal(okCount, 2);
    assert.equal(enriched[1].sources[0].fetchStatus, undefined);
  });

  it('creates LLM summary in summary mode', async () => {
    mockHtmlFetch('<html><title>Article</title><body><p>Long page about transformers.</p></body></html>');

    const [finding] = await enrichFindings([{
      question: 'transformers',
      sources: [{ title: 'Article', url: 'https://example.com/a', snippet: 'short' }],
    }], {
      query: 'transformers',
      fetchMode: 'summary',
      maxUrlsPerIteration: 8,
      maxUrlsTotal: 24,
      maxContentChars: 8000,
      enrichConcurrency: 1,
      llm: {
        async complete() {
          return 'Focused summary about transformers.';
        },
      },
    });

    assert.equal(finding.sources[0].fetchStatus, 'ok');
    assert.equal(finding.sources[0].summary, 'Focused summary about transformers.');
    assert.match(finding.sources[0].content, /transformers/);
  });
});

describe('source relevance filter', () => {
  it('keeps all findings when disabled', async () => {
    const findings = [{
      question: 'q',
      sources: [{ title: 'A', url: 'https://a', snippet: 'alpha' }],
    }];

    const filtered = await filterFindingsByRelevance(findings, {
      query: 'topic',
      llm: { async complete() { throw new Error('should not call llm'); } },
      enabled: false,
    });

    assert.deepEqual(filtered, findings);
  });

  it('degrades gracefully when LLM returns non-JSON', async () => {
    const findings = [{
      question: 'q',
      sources: [
        { title: 'A', url: 'https://a', snippet: 'alpha' },
        { title: 'B', url: 'https://b', snippet: 'beta' },
      ],
    }];

    const filtered = await filterFindingsByRelevance(findings, {
      query: 'topic',
      llm: { async complete() { return 'not valid json'; } },
      enabled: true,
      maxSourcesForReport: 30,
    });

    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].sources.length, 2);
    assert.equal(filtered[0].sources[0].relevanceScore, 0.5);
  });

  it('filters sources using LLM scores', async () => {
    const findings = [{
      question: 'q',
      sources: [
        { title: 'Keep', url: 'https://keep', snippet: 'good' },
        { title: 'Drop', url: 'https://drop', snippet: 'bad' },
      ],
    }];

    const filtered = await filterFindingsByRelevance(findings, {
      query: 'topic',
      llm: {
        async complete() {
          return JSON.stringify([
            { index: 1, keep: true, score: 0.9, reason: 'relevant' },
            { index: 2, keep: false, score: 0.1, reason: 'off-topic' },
          ]);
        },
      },
      enabled: true,
      maxSourcesForReport: 30,
    });

    assert.equal(filtered[0].sources.length, 1);
    assert.equal(filtered[0].sources[0].url, 'https://keep');
  });
});

describe('report and research context', () => {
  it('uses summary/content evidence in report prompt', () => {
    const messages = reportPrompt({
      query: 'llm wiki',
      findings: [{
        question: 'What is llm wiki?',
        sources: [{
          title: 'Wiki',
          url: 'https://example.com',
          snippet: 'title only snippet',
          summary: 'Karpathy LLM wiki summary evidence',
        }],
      }],
    });

    const userContent = messages[1].content;
    assert.match(userContent, /Evidence: Karpathy LLM wiki summary evidence/);
    assert.doesNotMatch(userContent, /Evidence: title only snippet/);
    assert.match(messages[0].content, /insufficient/i);
  });

  it('formats follow-up context from enriched evidence', () => {
    const context = formatSourcesForResearchContext([{
      question: 'q',
      sources: [{
        title: 'Wiki',
        url: 'https://example.com',
        snippet: 'short',
        content: 'Long enriched body about LLM wiki.',
      }],
    }], { limit: 5, charsPerSource: 100 });

    assert.match(context, /Evidence: Long enriched body about LLM wiki\./);
    assert.doesNotMatch(context, /Evidence: short/);
  });
});

describe('source-based pipeline', () => {
  it('matches disabled enrichment behavior with iterative flow', async () => {
    const searchedQuestions = [];

    const findings = await runStrategy({
      strategy: 'source-based',
      query: 'deep topic',
      settings: {
        research: {
          iterations: 2,
          questionsPerIteration: 1,
          concurrency: 1,
          sourceBased: { fetchMode: 'disabled' },
        },
      },
      search: {
        async search(question) {
          searchedQuestions.push(question);
          return [{
            title: question,
            url: `https://example.com/${searchedQuestions.length}`,
            snippet: `Snippet for ${question}`,
          }];
        },
      },
      llm: {
        async complete({ messages }) {
          return messages[1].content.includes('Evidence:')
            ? JSON.stringify(['second iteration question'])
            : JSON.stringify(['first iteration question']);
        },
      },
      emit: () => {},
    });

    assert.deepEqual(searchedQuestions, [
      'deep topic',
      'first iteration question',
      'second iteration question',
    ]);
    assert.deepEqual(findings.map((finding) => finding.iteration), [1, 1, 2]);
  });

  it('emits enrichment and filter stages when enabled', async () => {
    mockHtmlFetch('<html><title>T</title><body><p>Body</p></body></html>');
    const stages = [];

    await runSourceBasedPipeline({
      query: 'topic',
      iterations: 1,
      questionCount: 1,
      concurrency: 1,
      settings: {
        research: {
          sourceBased: {
            fetchMode: 'full',
            maxUrlsPerIteration: 4,
            maxUrlsTotal: 4,
            enableRelevanceFilter: true,
            maxSourcesForReport: 10,
          },
        },
      },
      search: {
        async search(question) {
          return [{
            title: question,
            url: `https://example.com/${encodeURIComponent(question)}`,
            snippet: 'snippet',
          }];
        },
      },
      llm: {
        async complete({ messages }) {
          if (messages[1].content.includes('Rate source relevance')) {
            return JSON.stringify([{ index: 1, keep: true, score: 0.8, reason: 'ok' }]);
          }
          return JSON.stringify(['sub question']);
        },
      },
      emit: (event) => {
        if (event.stage) stages.push(event.stage);
      },
    });

    assert.ok(stages.includes('enriching_sources'));
    assert.ok(stages.includes('filtering_sources'));
  });
});

describe('parallel strategy isolation', () => {
  it('keeps using shared iterative pipeline without sourceBased enrichment', async () => {
    const parallelPath = path.join(import.meta.dirname, '../src/research/strategies/parallel.mjs');
    const source = fs.readFileSync(parallelPath, 'utf8');
    assert.match(source, /runIterativeStrategy/);

    const stages = [];
    await runStrategy({
      strategy: 'parallel',
      query: 'parallel topic',
      settings: {
        research: {
          iterations: 1,
          questionsPerIteration: 1,
          concurrency: 1,
          sourceBased: {
            fetchMode: 'full',
            enableRelevanceFilter: true,
          },
        },
      },
      search: {
        async search(question) {
          return [{
            title: question,
            url: `https://example.com/${question}`,
            snippet: question,
          }];
        },
      },
      llm: {
        async complete() {
          return JSON.stringify(['follow-up']);
        },
      },
      emit: (event) => {
        if (event.stage) stages.push(event.stage);
      },
    });

    assert.equal(stages.includes('enriching_sources'), false);
    assert.equal(stages.includes('filtering_sources'), false);
  });
});
