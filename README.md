# js-deepresearch-agent

Local single-user deep research agent built with Node.js, Express, Vite, and SQLite.

The app can run research jobs from either a web UI or a CLI. It uses an OpenAI-compatible chat completions API or Ollama for generation, and a pluggable search backend for source discovery.

## Features

- Web UI for starting research, watching progress, and reading saved reports.
- CLI commands for running research, updating settings, and viewing history.
- Local SQLite storage for settings, research history, logs, and sources.
- Pluggable provider shape for OpenAI-compatible and Ollama LLM backends.
- Pluggable search adapter shape; the current MVP ships with SearXNG.

## Requirements

- Node.js 20 or newer.
- npm.
- A search backend. The current MVP supports SearXNG, defaulting to `http://127.0.0.1:8080`.
- Either an OpenAI-compatible API key/base URL or a local Ollama server.

## Getting Started

```bash
npm install
npm run build
npm run server
```

Then open `http://127.0.0.1:3000`.

For frontend development, run the API server and Vite dev server in separate terminals:

```bash
npm run server
npm run dev
```

The Vite dev server proxies `/api` requests to `http://127.0.0.1:3000`.

## CLI Usage

```bash
npm exec --package=. -- jdr help
npm exec --package=. -- jdr config get
npm exec --package=. -- jdr config set llm.apiKey "YOUR_API_KEY"
npm exec --package=. -- jdr config set search.baseUrl "http://127.0.0.1:8080"
npm exec --package=. -- jdr research "Explain the current state of local-first AI research" --output report.md
npm exec --package=. -- jdr history list
```

## Benchmark

Evaluate whether a saved research report is supported by its cited sources. The benchmark reads artifacts from a work session directory and does not rerun search or research.

```bash
npm run benchmark -- work_dir/source-based/2026-05-26_043125
npm run benchmark -- work_dir/source-based/2026-05-26_043125 --no-llm --json
npm run benchmark -- work_dir/source-based/2026-05-26_043125 --strict-platform js-eyes:zhihu
node scripts/benchmark-research.mjs --compare <researchIdA>,<researchIdB> --json
```

Expected inputs in the work directory:

- `report.md`
- `findings.json`
- `sources.json`
- `meta.json`

Use `--no-llm` for offline checks. Schema v3 claims reuse their stored verdicts without calling an LLM; legacy artifacts are evaluated with deterministic rules. Output records whether each effective verdict came from `stored_rule`, `stored_llm`, `runtime_rule`, or `runtime_llm`.

Quality metrics v2 count claims, not individual evidence links. Fact-claim verdicts are mutually exclusive (`supported`, `partially_supported`, `unsupported`, `unverifiable`, or `conflicting`), so their counts always add up to `evaluatedClaimCount`. Caveats and recommendations remain visible but are excluded from fact-claim support rates, source-list entries are not claims, and rates with no denominator are reported as `null`/`n/a` instead of a misleading zero.

Report output is validated before a run can complete. The engine requires a Markdown heading and at least `research.reportValidation.minChars` characters (default `200`), retries once by default, and raises `REPORT_OUTPUT_INVALID` if the provider still returns an empty or placeholder response. Failed validation writes no report artifacts and the CLI/Web history state is `failed`. LLM progress records purpose, duration, output length, finish reason, and whether reasoning metadata existed, but never stores prompts or reasoning text.

Qwen models used through an OpenAI-compatible endpoint automatically request `reasoning_effort: none`; this prevents small summary/report token budgets from being consumed entirely by a hidden `reasoning` field while final `content` remains empty.

For `source-based` research, official documentation, repositories, specifications, and papers receive a primary-source boost. Missing primary evidence opens a focused follow-up query and is preserved as a quality limitation. Direct-evidence passages are created only from successfully fetched source bodies; search snippets remain `search_snippet` evidence.

You can also override settings for one run:

```bash
npm exec --package=. -- jdr research "Compare SearXNG and Brave Search APIs" \
  --provider openai-compatible \
  --model gpt-4o-mini \
  --base-url https://api.openai.com/v1 \
  --search-base-url http://127.0.0.1:8080 \
  --strategy source-based \
  --iterations 2 \
  --questions 3 \
  --concurrency 2

# Override JS Eyes skills for one run without editing .env
npm exec --package=. -- jdr research "openclaw" \
  --search js-eyes \
  --search-skills js-reddit-ops-skill \
  --strategy rapid

# Source-based deep reading: fetch page content or LLM summaries before report synthesis
npm exec --package=. -- jdr research "llm wiki" \
  --search js-eyes \
  --search-skills js-zhihu-ops-skill \
  --strategy source-based \
  --source-fetch-mode summary \
  --source-fetch-backend js-eyes \
  --source-max-urls 12 \
  --source-enable-filter true \
  --source-max-sources 30
```

## Configuration

Runtime settings are stored in the local SQLite database under `data/`. Values from `.env` are loaded automatically on startup and override saved settings when present. The default settings are:

- LLM provider: `openai-compatible`
- LLM model: `gpt-4o-mini`
- LLM base URL: `https://api.openai.com/v1`
- Search engine: `searxng`
- Search base URL: `http://127.0.0.1:8080`
- Research strategy: `source-based`
- Research iterations: `2`
- Research questions per iteration: `3`
- Research concurrency: `2`

SearXNG is the default search adapter in the embeddable `js-deepresearch-engine` package. **JS Eyes is an app-local provider** registered at startup from `src/search-providers/`—it is not bundled inside the npm package. DuckDuckGo, Tavily, and Brave Search are represented in the adapter metadata for later implementation.

### JS Eyes Search Provider (App-Local)

Set `SEARCH_ENGINE=js-eyes` to run searches through JS Eyes. The app registers this provider via [`src/search-providers/register-local-search-engines.mjs`](src/search-providers/register-local-search-engines.mjs). Legacy `JS_EYES_*` settings are normalized into `search.provider` by the app layer and the driver is chosen automatically:

- **unified**: `js-eyes search "query" --skills ... --json` when the upstream facade supports the skill
- **skill-run**: `js-eyes skill run <skillId> search "query" ...` for skills with local profiles (for example Reddit)

```bash
js-eyes search "query" --skills js-x-ops-skill --max-results 8 --max-pages 1 --server ws://localhost:18080 --json
```

The provider reads unified `items[]` (or raw skill payloads for skill-run fallback) and maps them into research sources. Skill-specific argv differences are handled by the app-local skill registry at [`src/search-providers/js-eyes/skill-registry.mjs`](src/search-providers/js-eyes/skill-registry.mjs)—no js-eyes repo changes required for new fallback profiles.

Before using this provider:

- Install the `js-eyes` CLI.
- Start the JS Eyes server, for example `js-eyes server start`.
- Connect the browser extension to the local server.
- Install, approve, and enable the target skill, such as `js-zhihu-ops-skill` or `js-xiaohongshu-ops-skill`.
- Log in to the target site in the connected browser if the skill needs authenticated access.
- Run `js-eyes doctor --json` to verify the local JS Eyes setup.

Example environment:

```bash
SEARCH_ENGINE=js-eyes
JS_EYES_SKILL=js-zhihu-ops-skill
JS_EYES_SERVER_URL=ws://localhost:18080
JS_EYES_MAX_PAGES=1
JS_EYES_TIMEOUT_MS=120000
```

To search multiple sites in one research run, provide comma-separated skill IDs:

```bash
JS_EYES_SKILL=js-zhihu-ops-skill,js-xiaohongshu-ops-skill
```

Or pass skills only for the current CLI run:

```bash
npm exec --package=. -- jdr research "openclaw" --search js-eyes --search-skills js-reddit-ops-skill
```

Legacy `--js-eyes-skill` and `JS_EYES_*` env vars remain supported.

Each configured skill is queried serially through the unified JS Eyes search command. Results are interleaved across skills, deduplicated by URL, and capped by the global `maxResults` setting. If one skill fails, the provider returns results from the skills that succeeded; the search only fails when every configured skill fails. Browser-backed providers automatically cap question concurrency to 1.

For Xiaohongshu-only search, set `JS_EYES_SKILL=js-xiaohongshu-ops-skill`. On Linux and macOS, leave `JS_EYES_CLI=js-eyes` when the CLI is on `PATH`. On Windows, the provider resolves npm global shims such as `js-eyes.cmd` automatically; set `JS_EYES_CLI` to an absolute path only when the CLI is installed outside `PATH`. Prefer `ws://localhost:18080` over `127.0.0.1` if your local JS Eyes server binds to localhost. Common failures usually mean the CLI is not on `PATH`, the skill is not enabled, the server or extension is disconnected, the site login expired, policy/egress blocked navigation, or the target site triggered a risk check. Use `js-eyes doctor --json` and the JS Eyes skill records for diagnosis.

Available research strategies are exposed through `/api/strategies` and shared by the web UI:

- `rapid`: fast research that searches the original query plus a few follow-up questions.
- `source-based`: default iterative research that generates source-informed follow-up questions. Default URL enrichment uses `research.sourceBased.fetchMode: summary` (LLM-compressed page summaries before report synthesis). Use `disabled` for snippet-only fast runs; relevance filtering stays off by default.
- `parallel`: broad research that runs generated questions with controlled concurrency.
- `adaptive`: experimental gap-driven research with bounded steps, shared budgets, structured progress, and evidence evaluation.

`source-based` defaults to a quality preset: `fetchMode: summary`, query memory, source clustering, passage/claim evidence, adaptive early-stop, and soft budgets (`maxSearchRequests: 10`, `maxSourceReads: 8`). Override per run with CLI flags such as `--source-fetch-mode disabled` or `config set` / Web UI settings. `preReportGate` and LLM relevance filtering remain off by default.

Semantic reranking is an optional observation, not a prerequisite or automatic source selector. The default `rules` provider is local and deterministic; `--rerank-provider jina` opts into Jina for that run and requires `--rerank-api-key` (or `JINA_API_KEY`). Provider errors fall back to rules, while cancellation and budget limits remain hard stops. Embeddings are disabled by default and are not needed by any current strategy.

Completed work sessions use artifact schema v3. The original `report.md`, `findings.json`, `sources.json`, and `meta.json` remain compatible; optional `gaps.json`, `passages.json`, `claims.json`, `quality.json`, and `trace.json` preserve evidence links, quality state, budgets, and structured actions. Intel Store v2 runs remain readable and can be upgraded idempotently with `intel import --upgrade-existing`.

Use the web UI, `.env`, or `jdr config set <key> <value>` to update them.

Supported `.env` keys:

- `PORT`
- `LLM_PROVIDER`
- `LLM_MODEL`
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OLLAMA_BASE_URL`
- `SEARCH_ENGINE`
- `SEARCH_BASE_URL`
- `SEARCH_API_KEY`
- `JS_EYES_CLI`
- `JS_EYES_SKILL`
- `JS_EYES_COMMAND`
- `JS_EYES_SERVER_URL`
- `JS_EYES_MAX_PAGES`
- `JS_EYES_TIMEOUT_MS`

Do not commit API keys or local database files. `.env.example` documents common local values.

## Scripts

- `npm run dev` starts the Vite frontend dev server.
- `npm run server` starts the Express API and serves the built frontend.
- `npm run build` builds the web UI into `dist/`.
- `npm test` runs the Node test suite.
- `npm run lint` runs ESLint.

## Project Structure

This repository is an npm workspace. The agent application lives at the root; the embeddable research runtime is in `packages/js-deepresearch-engine`.

```text
packages/js-deepresearch-engine/
  src/        Embeddable research engine (LLM, search, strategies, runner)
  tests/      Engine unit tests

src/
  api/        Express app and HTTP routes
  config/     Env loading and SQLite-backed settings persistence
  jobs/       Research job orchestration
  search-providers/  App-local search adapters (JS Eyes registry, skill profiles)
  storage/    SQLite repositories and migrations
  cli.mjs     CLI entry point
web/          Vite frontend
tests/        Agent integration tests
```

After `npm install`, the agent links the local engine package via `workspace:*`. Changes to the engine are picked up without publishing to npm.

## Git Hygiene

Generated files and local runtime state are intentionally ignored:

- `node_modules/`
- `dist/`
- `data/`
- `.env`

Run `npm run lint` and `npm test` before opening a pull request.
