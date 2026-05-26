import { resetLlmProviders } from './llm/provider-factory.mjs';
import { resetSearchEngines } from './search/search-factory.mjs';
import { resetContentFetchHandlers } from './research/content-resolver.mjs';
import { resetStrategyRegistry } from './research/strategies.mjs';

export function resetEngineRegistries() {
  resetLlmProviders();
  resetSearchEngines();
  resetStrategyRegistry();
  resetContentFetchHandlers();
}
