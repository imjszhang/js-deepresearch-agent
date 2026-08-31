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
    strategy: 'focused',
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

`query` may also be a versioned structured brief. Unspecified fields remain empty:

```javascript
const result = await runner.run({
  query: {
    schemaVersion: 1,
    query: 'Compare alpha and beta for production use',
    audience: 'platform engineers',
    decision: 'select a runtime',
    depth: 'focused',
    requiredAnswerSlots: [
      { answerSlot: 'reliability', question: 'What failure modes are documented?', priority: 'critical' },
    ],
    consequentialClaims: ['safe for production'],
  },
  settings,
});
```

Focused runs use bounded discovery/merge/repair waves and the same deterministic base readiness checks as exploratory runs. Gap schema v2 is claim/answer-slot aware. Search snippets never verify deep-research gaps, and semantic providers cannot override readiness failures.

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
  run: async ({ query, emit }) => {
    emit('Echo strategy running', 50);
    return [{ question: query, sources: [] }];
  },
});
```

### Registry usage guidelines

| Use case | Recommended API | Notes |
| --- | --- | --- |
| Register custom adapters or strategies | `registerLlmProvider()` / `registerSearchEngine()` / `registerStrategy()` | Preferred extension path at startup |
| Read registered strategies | `getStrategyRegistry()` | Returns a shallow copy; do not mutate |
| Legacy registry access | `strategyRegistry` | Still exported for compatibility; direct mutation is discouraged |
| Test or embed isolation | `resetEngineRegistries()` or individual `reset*()` helpers | Intended for tests and controlled re-initialization, not per-request runtime use |

Reset helpers restore built-in providers, search engines, and strategies. They are useful when tests register temporary mocks, but they should not be called on every normal research request.

## Settings Schema

Use `defaultSettings` and `mergeSettings` to build a normalized settings object:

```javascript
import { defaultSettings, mergeSettings } from 'js-deepresearch-engine';

const settings = mergeSettings({
  llm: { model: 'gpt-4o' },
  search: { maxResults: 10 },
  research: { strategy: 'quick', iterations: 1 },
});
```

The engine does not read `.env` files or persist settings. Callers are responsible for loading configuration and passing a merged `settings` object.

## Built-in Strategies

- `quick` — snippet-only scan. One iteration is original query plus a few follow-ups; more than one iteration uses the shared iterative loop. It does not enrich URL bodies.
- `focused` — default topic research: source-informed follow-ups, optional URL enrichment, source selection, evidence chain, and iteration/evidence early-stop
- `exploratory` — budget-driven agent loop that chooses structured `search`, `read`, `reflect`, `answer`, or `stop` actions. Spend at least `research.exploratory.minLlmTokens` (default 600000) exploring before evidence sufficiency may stop the loop. `research.exploratory.maxLlmTokens` (default 1000000) is the exploration ceiling and does not include the final report; a tighter `research.budget.maxLlmTokens` still wins for exploration. `research.report.maxOutputTokens` defaults to `0` (no app-layer report cap). Search/read count caps and `maxSteps` default to `0` (unlimited) and do not inherit `research.budget` counts. A 64-step safety valve applies only when both the exploratory and global token ceilings are off.

Custom strategies can still be added with `registerStrategy()`. Historical IDs (`rapid`, `parallel`, `source-based`, `adaptive`) are not registered.

## Research Controls and Schema v3

`focused` defaults to a quality-oriented preset: `fetchMode: summary`, enabled `queryMemory`, `sourceSelection`, `evidencePassages` (with `claimAlignment`), and `iterationControl`, plus soft budgets (`maxSearchRequests: 18`, `maxSourceReads: 16`). Those global count budgets apply to `focused` / `quick` only. Set `fetchMode: disabled` or turn individual controls off when embedding the engine in latency-sensitive paths. `preReportGate` and LLM relevance filtering stay disabled by default.

Schema v3 results retain `report`, `findings`, and `sources` and add `gaps`, `passages`, `claims`, `quality`, and a structured `trace`. Passage and claim generation run when `evidencePassages` is enabled (default for `focused`). Semantic helpers use pluggable research providers and deterministic local fallbacks. `supportedRate` scores only Summary / Key Findings atoms; `supportedOrPartialRate` also counts partial support. Evidence dumps are not part of that denominator. Cited key claims with source bodies that rules cannot clearly support or reject are judged by `research.quality.entailment` (`rules_then_llm` by default; set `rules` to disable).

Reranking is optional. `research.providers.rerank.provider` defaults to `rules`, which performs deterministic Unicode token-overlap scoring without network access. Set it to `jina` and provide an API key to opt into Jina reranking; failures degrade to rules, while cancellation and budget exhaustion continue to propagate. Embeddings are not required and no remote embedding provider is enabled by default.

```javascript
const settings = mergeSettings({
  research: {
    providers: { rerank: { provider: 'jina', apiKey: process.env.JINA_API_KEY } },
    budget: { maxRerankRequests: 4, maxRerankTokens: 8000 },
  },
});
```

Quality metrics v2 classify report statements as fact claims, caveats, recommendations, source entries, or metadata. Only key/supporting fact claims enter support-rate denominators. Every fact claim receives one aggregate verdict, including `conflicting` for contradictory evidence; zero-denominator rates are `null`. Artifacts record the metrics, extraction, and evaluation versions so benchmarks can distinguish stored evaluation from a new runtime judgment.

Report synthesis validates non-empty Markdown output with `research.reportValidation.minChars` (default `200`) and `maxAttempts` (default `2`). Invalid output is retried with a final-answer-only prompt, then raises `ReportGenerationError` instead of returning a completed run. Structured LLM telemetry records only safe operational metadata. Focused runs also emit gaps and rule-based limitations, focus follow-up searches on missing primary evidence, and only build direct passages from source bodies whose fetch completed successfully.

Some Qwen OpenAI-compatible servers spend bounded completion tokens in a `reasoning` field and return empty final `content`. The built-in adapter automatically requests `reasoning_effort: none` for Qwen models, preserves token/finish metadata, and records only whether a reasoning field existed—not its contents.

## Built-in LLM Providers

- `openai-compatible` — any OpenAI-compatible chat completions API
- `ollama` — local Ollama server

Reserved metadata entries exist for future adapters (`anthropic`, `google`, `openrouter`).

## Built-in Search Engines

- `searxng` — SearXNG JSON API

Additional search engines can be registered at runtime via `registerSearchEngine()`. The js-deepresearch-agent app registers `js-eyes` locally from `src/search-providers/`; that adapter is **not** bundled in this npm package.

## Progress Events

Built-in strategies emit structured progress events internally. `ResearchRunner` maps them to the public callback shape:

```javascript
onProgress({ message, progress, level })
```

Custom strategies may continue using the legacy form:

```javascript
emit('Custom stage message', 42);
```

Or emit structured events if you want the runner-style mapper in your own integration.

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
| `createResearchProviders`, `RulesRerankProvider`, `JinaRerankProvider` | Optional semantic provider composition and rerank adapters |

## Requirements

- Node.js 20 or newer
- No runtime npm dependencies

## License

ISC
