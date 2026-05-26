# js-deepresearch-engine

Embeddable deep research runtime for Node.js. Run iterative web research with pluggable LLM backends, search engines, and research strategies.

This package powers [js-deepresearch-agent](https://github.com/My/js-deepresearch-agent) but can also be used directly from scripts, servers, or other agent frameworks.

## Install

```bash
npm install js-deepresearch-engine
```

When developing inside the monorepo workspace, the agent links this package automatically via `workspace:*`.

## Quick Start

```javascript
import { ResearchRunner, mergeSettings } from 'js-deepresearch-engine';

const runner = new ResearchRunner();
const settings = mergeSettings({
  llm: {
    provider: 'openai-compatible',
    model: 'gpt-4o-mini',
    apiKey: process.env.OPENAI_API_KEY,
  },
  search: {
    engine: 'searxng',
    baseUrl: 'http://127.0.0.1:8080',
  },
  research: {
    strategy: 'source-based',
    iterations: 2,
    questionsPerIteration: 3,
    concurrency: 2,
  },
});

const result = await runner.run({
  query: 'Explain the current state of local-first AI research',
  settings,
  onProgress: ({ message, progress }) => {
    console.error(`[${progress ?? '-'}%] ${message}`);
  },
});

console.log(result.report);
```

## Injecting Mock Adapters

For tests or custom integrations, pass `llm` and `search` directly:

```javascript
const result = await runner.run({
  query: 'test topic',
  settings,
  llm: {
    async complete() {
      return JSON.stringify(['follow up question']);
    },
  },
  search: {
    async search(question) {
      return [{ title: question, url: 'https://example.com', snippet: 'Evidence' }];
    },
  },
});
```

## Extending Registries

Register custom providers, search engines, or strategies at startup:

```javascript
import {
  registerLlmProvider,
  registerSearchEngine,
  registerStrategy,
} from 'js-deepresearch-engine';

registerLlmProvider('my-llm', {
  metadata: { label: 'My LLM', requiresApiKey: true },
  create: (config) => new MyLlmProvider(config),
});

registerSearchEngine('my-search', {
  metadata: { label: 'My Search' },
  create: (config) => new MySearchEngine(config),
});

registerStrategy('echo', {
  label: 'Echo',
  description: 'Returns the query as a single finding.',
  run: async ({ query }) => [{ question: query, sources: [] }],
});
```

## Settings Schema

Use `defaultSettings` and `mergeSettings` to build a normalized settings object:

```javascript
import { defaultSettings, mergeSettings } from 'js-deepresearch-engine';

const settings = mergeSettings({
  llm: { model: 'gpt-4o' },
  search: { maxResults: 10 },
  research: { strategy: 'rapid' },
});
```

The engine does not read `.env` files or persist settings. Callers are responsible for loading configuration and passing a merged `settings` object.

## Built-in Strategies

- `rapid` — original query plus a few fast follow-up searches
- `source-based` — iterative, source-informed follow-up questions (default)
- `parallel` — broad coverage with controlled concurrency

## Built-in LLM Providers

- `openai-compatible` — any OpenAI-compatible chat completions API
- `ollama` — local Ollama server

Reserved metadata entries exist for future adapters (`anthropic`, `google`, `openrouter`).

## Built-in Search Engines

- `searxng` — SearXNG JSON API

Additional search engines can be registered at runtime via `registerSearchEngine()`. The js-deepresearch-agent app registers `js-eyes` locally from `src/search-providers/`; that adapter is **not** bundled in this npm package.

`strategyRegistry` remains exported for backward compatibility, but prefer `getStrategyRegistry()` or `registerStrategy()` instead of mutating the registry object directly.

## Work Directory Artifacts

Optional file output helpers are included for CLI-style integrations:

```javascript
import { saveResearchToWorkDir } from 'js-deepresearch-engine';

const artifacts = saveResearchToWorkDir({
  settings,
  strategy: settings.research.strategy,
  query: 'My query',
  result,
});
```

## Public API

| Export | Description |
| --- | --- |
| `ResearchRunner` | Main research orchestrator |
| `runStrategy`, `strategyMetadata`, `registerStrategy`, `getStrategyRegistry` | Strategy registry |
| `resetStrategyRegistry`, `resetLlmProviders`, `resetSearchEngines`, `resetEngineRegistries` | Test/helper reset for registry state |
| `createLlmProvider`, `providerMetadata`, `registerLlmProvider` | LLM registry |
| `createSearchEngine`, `searchEngineMetadata`, `registerSearchEngine` | Search registry |
| `defaultSettings`, `mergeSettings` | Settings schema |
| `saveResearchToWorkDir`, `saveResearchArtifacts`, `createWorkSessionDir` | Artifact writers |
| `normalizeSearchConfig`, `resolveSearchConcurrency` | Generic search config helpers |

## Requirements

- Node.js 20 or newer
- No runtime npm dependencies

## License

ISC
