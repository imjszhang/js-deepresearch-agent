import { SearxngSearchEngine } from './engines/searxng.mjs';
import { JsEyesCliSearchEngine } from './engines/js-eyes.mjs';

export const searchEngineMetadata = [
  {
    id: 'searxng',
    label: 'SearXNG',
    supportsBaseUrl: true,
  },
  {
    id: 'js-eyes',
    label: 'JS Eyes',
    requiresBrowser: true,
    supportsServerUrl: true,
  },
  {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    disabledReason: 'Adapter reserved for a later MVP increment.',
  },
  {
    id: 'tavily',
    label: 'Tavily',
    disabledReason: 'Adapter reserved for a later MVP increment.',
  },
  {
    id: 'brave',
    label: 'Brave Search',
    disabledReason: 'Adapter reserved for a later MVP increment.',
  },
];

export function createSearchEngine(settings) {
  if (settings.search.engine === 'searxng') {
    return new SearxngSearchEngine(settings.search);
  }
  if (settings.search.engine === 'js-eyes') {
    return new JsEyesCliSearchEngine(settings.search);
  }
  throw new Error(`Unsupported search engine for MVP: ${settings.search.engine}`);
}
