import { attachSearchMeta, collectRespondedEngines } from '../search-result.mjs';
import { resolveSearchRequestOptions } from '../normalize-search-config.mjs';
import { DEFAULT_SEARCH_CAPABILITIES, filterSearchOptions } from '../search-capabilities.mjs';
import { SearchProviderError } from '../search-provider-error.mjs';

export class SearxngSearchEngine {
  constructor(config) {
    this.config = config;
    this.capabilities = {
      ...DEFAULT_SEARCH_CAPABILITIES,
      maxQuestionConcurrency: null,
      supportedSearchOptions: ['engines', 'categories', 'language', 'pageno', 'safesearch'],
      fixedEngine: null,
    };
  }

  async search(query, { signal, searchOptions } = {}) {
    const baseUrl = (this.config.baseUrl || 'http://127.0.0.1:8080').replace(/\/$/, '');
    const requested = resolveSearchRequestOptions(this.config, searchOptions);
    const { effective } = filterSearchOptions(requested, this.capabilities);
    const request = effective;
    const url = new URL(`${baseUrl}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('language', request.language || this.config.language || 'en');
    url.searchParams.set('safesearch', request.safesearch ?? (this.config.safeSearch ? '1' : '0'));
    if (request.engines) url.searchParams.set('engines', request.engines);
    if (request.categories) url.searchParams.set('categories', request.categories);
    if (request.pageno) url.searchParams.set('pageno', String(request.pageno));

    const requestParams = Object.fromEntries(url.searchParams.entries());
    const response = await fetch(url, {
      signal,
      headers: {
        accept: 'application/json',
      },
    });

    if (!response.ok) {
      const detail = await response.text();
      if (response.status === 429) {
        throw new SearchProviderError(`SearXNG search failed (429): ${detail}`, {
          code: 'rate_limited',
          retryable: true,
          provider: 'searxng',
        });
      }
      throw new Error(`SearXNG search failed (${response.status}): ${detail}`);
    }

    const data = await response.json();
    const sources = (data.results || [])
      .slice(0, this.config.maxResults || 8)
      .map((item) => ({
        title: item.title || item.url || 'Untitled source',
        url: item.url || '',
        snippet: item.content || item.snippet || '',
        engine: 'searxng',
        ...(Array.isArray(item.engines) && item.engines.length ? { engines: item.engines } : {}),
        ...(item.category ? { category: item.category } : {}),
        ...(item.publisher ? { publisher: item.publisher } : {}),
        ...(item.author ? { author: item.author } : {}),
        ...(item.publishedAt || item.publishedDate || item.date
          ? { publishedAt: item.publishedAt || item.publishedDate || item.date }
          : {}),
        ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
        ...(item.sourceType ? { sourceType: item.sourceType } : {}),
      }))
      .filter((item) => item.url || item.snippet);

    return attachSearchMeta(sources, {
      requestedSearchOptions: requested,
      effectiveSearchOptions: effective,
      requestParams,
      numberOfResults: data.number_of_results ?? null,
      suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
      corrections: Array.isArray(data.corrections) ? data.corrections : [],
      unresponsiveEngines: Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines : [],
      respondedEngines: collectRespondedEngines(sources),
      providerRetries: 0,
    });
  }
}
