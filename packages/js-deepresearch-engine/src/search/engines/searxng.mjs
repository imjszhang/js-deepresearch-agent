export class SearxngSearchEngine {
  constructor(config) {
    this.config = config;
    this.capabilities = {
      maxQuestionConcurrency: null,
    };
  }

  async search(query, { signal } = {}) {
    const baseUrl = (this.config.baseUrl || this.config.searxngUrl || 'http://127.0.0.1:8080').replace(/\/$/, '');
    const url = new URL(`${baseUrl}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('language', this.config.language || 'en');
    url.searchParams.set('safesearch', this.config.safeSearch ? '1' : '0');

    const response = await fetch(url, {
      signal,
      headers: {
        accept: 'application/json',
      },
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`SearXNG search failed (${response.status}): ${detail}`);
    }

    const data = await response.json();
    return (data.results || [])
      .slice(0, this.config.maxResults || 8)
      .map((item) => ({
        title: item.title || item.url || 'Untitled source',
        url: item.url || '',
        snippet: item.content || item.snippet || '',
        engine: 'searxng',
      }))
      .filter((item) => item.url || item.snippet);
  }
}
