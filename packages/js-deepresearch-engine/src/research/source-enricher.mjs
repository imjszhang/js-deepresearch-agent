import { resolveUrlContent } from './content-resolver.mjs';

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function buildSummaryPrompt({ query, question, title, url, content }) {
  return [
    {
      role: 'system',
      content: 'Extract only facts relevant to the research query. Return plain text, no markdown.',
    },
    {
      role: 'user',
      content: [
        `Research query: ${query}`,
        question ? `Focus question: ${question}` : '',
        `Source title: ${title}`,
        `Source URL: ${url}`,
        '',
        'Page content:',
        content,
      ].filter(Boolean).join('\n'),
    },
  ];
}

async function enrichOneSource(source, {
  query,
  question,
  llm,
  signal,
  fetchMode,
  maxContentChars,
  settings,
}) {
  const url = String(source.url || '').trim();
  if (!url) {
    return {
      ...source,
      fetchStatus: 'skipped',
      fetchError: 'Missing URL',
    };
  }

  const fetched = await resolveUrlContent(url, {
    source,
    settings,
    signal,
    maxChars: maxContentChars,
  });
  if (fetched.status !== 'ok') {
    return {
      ...source,
      fetchStatus: 'failed',
      fetchError: fetched.error || 'Fetch failed',
    };
  }

  if (fetchMode === 'full') {
    return {
      ...source,
      title: source.title || fetched.title,
      content: fetched.content,
      fetchStatus: 'ok',
    };
  }

  const summary = await llm.complete({
    messages: buildSummaryPrompt({
      query,
      question,
      title: source.title || fetched.title,
      url,
      content: fetched.content,
    }),
    signal,
    temperature: 0,
    maxTokens: 600,
  });

  return {
    ...source,
    title: source.title || fetched.title,
    content: fetched.content,
    summary: String(summary || '').trim() || source.snippet,
    fetchStatus: 'ok',
  };
}

export async function enrichFindingSources(finding, options = {}) {
  const {
    query,
    fetchMode,
    maxUrlsPerIteration,
    maxUrlsTotal,
    maxContentChars,
    enrichConcurrency,
    llm,
    signal,
    settings,
    seenUrls = new Set(),
    enrichedCount = { value: 0 },
  } = options;

  if (fetchMode === 'disabled' || !Array.isArray(finding?.sources) || finding.sources.length === 0) {
    return finding;
  }

  const candidates = [];
  for (const source of finding.sources) {
    const url = String(source.url || '').trim();
    if (!url || seenUrls.has(url)) continue;
    if (enrichedCount.value >= maxUrlsTotal) break;
    if (candidates.length >= maxUrlsPerIteration) break;
    seenUrls.add(url);
    candidates.push(source);
  }

  if (candidates.length === 0) {
    return finding;
  }

  const enrichedByUrl = new Map();
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < candidates.length) {
      if (signal?.aborted) {
        const error = new Error('Research aborted');
        error.name = 'AbortError';
        throw error;
      }

      const index = nextIndex;
      nextIndex += 1;
      const source = candidates[index];

      try {
        const enriched = await enrichOneSource(source, {
          query,
          question: finding.question,
          llm,
          signal,
          fetchMode,
          maxContentChars,
          settings,
        });
        enrichedByUrl.set(source.url, enriched);
        if (enriched.fetchStatus === 'ok') {
          enrichedCount.value += 1;
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        enrichedByUrl.set(source.url, {
          ...source,
          fetchStatus: 'failed',
          fetchError: error.message,
        });
      }
    }
  }

  const workers = Math.min(enrichConcurrency, candidates.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  return {
    ...finding,
    sources: finding.sources.map((source) => enrichedByUrl.get(source.url) || source),
  };
}

export async function enrichFindings(findings = [], options = {}) {
  const seenUrls = new Set();
  const enrichedCount = { value: 0 };
  const enrichedFindings = [];

  for (const finding of findings) {
    enrichedFindings.push(await enrichFindingSources(finding, {
      ...options,
      seenUrls,
      enrichedCount,
    }));
  }

  return enrichedFindings;
}
