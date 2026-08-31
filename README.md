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
npm run benchmark -- work_dir/focused/2026-05-26_043125
npm run benchmark -- work_dir/focused/2026-05-26_043125 --no-llm --json
npm run benchmark -- work_dir/focused/2026-05-26_043125 --strict-platform js-eyes:zhihu
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

For `focused` research, official documentation, repositories, specifications, and papers receive a primary-source boost. Missing primary evidence opens a focused follow-up query and is preserved as a quality limitation. Direct-evidence passages are created only from successfully fetched source bodies; search snippets remain `search_snippet` evidence.

You can also override settings for one run:

```bash
npm exec --package=. -- jdr research "Compare SearXNG and Brave Search APIs" \
  --provider openai-compatible \
  --model gpt-4o-mini \
  --base-url https://api.openai.com/v1 \
  --search-base-url http://127.0.0.1:8080 \
  --strategy focused \
  --iterations 2 \
  --questions 3 \
  --concurrency 2

# Override JS Eyes skills for one run without editing .env
npm exec --package=. -- jdr research "openclaw" \
  --search js-eyes \
  --search-skills js-reddit-ops-skill \
  --strategy quick \
  --iterations 1

# Focused deep reading: fetch page content or LLM summaries before report synthesis
npm exec --package=. -- jdr research "llm wiki" \
  --search js-eyes \
  --search-skills js-zhihu-ops-skill \
  --strategy focused \
  --focused-fetch-mode summary \
  --focused-fetch-backend js-eyes \
  --focused-max-urls 12 \
  --focused-enable-filter true \
  --focused-max-sources 30
```

## Configuration

Runtime settings are stored in the local SQLite database under `data/`. Values from `.env` are loaded automatically on startup and override saved settings when present. The default settings are:

- LLM provider: `openai-compatible`
- LLM model: `gpt-4o-mini`
- LLM base URL: `https://api.openai.com/v1`
- Search engine: `searxng`
- Search base URL: `http://127.0.0.1:8080`
- Research strategy: `focused`
- Research iterations: `2` (focused fallback when iteration control is off; `--strategy quick` defaults to 1)
- Research questions per iteration: `2`
- Research concurrency: `1`

SearXNG is the default search adapter in the embeddable `js-deepresearch-engine` package. **JS Eyes and local directories are app-local providers** registered at startup from `src/search-providers/`—they are not bundled inside the npm package. DuckDuckGo, Tavily, and Brave Search are represented in the adapter metadata for later implementation.

### Local Directory Search Provider (App-Local)

`local` is a search source, not a new research strategy and not a persistent vector index. Each configured directory is an independent channel (search separately, fail separately, round-robin merge), matching the JS Eyes skill model. Hits enter the existing enrich path as normalized `file://` absolute URLs. `quick` keeps snippet-only evidence; `focused` / `exploratory` read file bodies. Files outside a configured corpus root (including `../` and outbound symlinks) are rejected.

Using local **together** with SearXNG or JS Eyes in one run depends on issue #16 fan-out. Until that lands, `--corpus-dirs` enables `local` for the current run so directories are not silently dropped:

```bash
npm exec --package=. -- jdr research "监管处罚" \
  --search local \
  --corpus-dirs ~/notes/尽调,~/Downloads/年报 \
  --strategy focused
```

Set `SEARCH_ENGINE=local` and `SEARCH_LOCAL_DIRS` (or `JDR_CORPUS_DIRS`) in `.env`, or `config get search.local.dirs`. Web UI: choose **Local directories** and enter one path per line or comma-separated paths.

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

- `quick` (快速调研): snippet-only scan with query-memory deduplication in both single- and multi-round runs. It never reads source bodies.
- `focused` (专题调研, default): builds a versioned `ResearchBrief`, then runs discovery plus optional repair waves. `research.iterations` still applies when `iterationControl` is off; when it is on, `minIterations` / `maxIterations`, `earlyStop`, and `continueOnCriticalGaps` keep their previous meanings. Repair covers every open required slot, not only critical gaps. Challenge searches only slots whose normalized identity matches `consequentialClaims`.
- `exploratory` (探索性调研): budget-driven Search-Read-Reason loop. The deterministic readiness gate, cancellation, and token floor/ceiling remain authoritative. Low novelty and repeated results redirect the next search angle, but plateau cannot cross the token floor or turn a failed gate into `evidence_sufficient`.

`ResearchRunner.run()` accepts the existing string `query` or a structured brief object. User-supplied structured values win: the planner may fill empty fields only and cannot overwrite user exclusions, slots, hosts, or success criteria. User-provided slot hosts are kept after hostname sanitization; planner-added slot hosts still require a hostname that appears literally in the query. Profile-level `requiredHosts` remain a separate planner commitment. `ResearchBrief.schemaVersion` is `1`; claim/slot gaps use schema version `2` and the states `open`, `searched`, `body_read`, `verified`, `conflicting`, and `limited`. Snippets cannot verify focused/exploratory gaps.

Shared body-reading defaults live under `research.read` (`fetchMode`, `maxContentChars`, `enrichConcurrency`). Existing `research.focused.*` read settings remain a compatibility fallback. The previously exposed but unused exploratory settings `plannerParallelism` and `enableCoding` were removed.

Historical `work_dir/rapid|parallel|source-based|adaptive/` sessions remain readable. New runs write `work_dir/quick|focused|exploratory/`.

Semantic reranking is an optional observation, not a prerequisite or automatic source selector. The default `rules` provider is local and deterministic; `--rerank-provider jina` opts into Jina for that run and requires `--rerank-api-key` (or `JINA_API_KEY`). Provider errors fall back to rules, while cancellation and budget limits remain hard stops. Embeddings are disabled by default and are not needed by any current strategy.

Completed work sessions use artifact schema v3. The original files remain compatible; `brief.json`, `gaps.json`, `passages.json`, `claims.json`, `quality.json`, and `trace.json` preserve the research contract, evidence links, wave/challenge/plateau decisions, and budgets. Observed publisher, author, publication/update/access dates, source type, jurisdiction, product version, and access status round-trip through sources, Intel, reports, and Wiki; missing values are not synthesized.

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
- `SEARCH_LOCAL_DIRS`
- `JDR_CORPUS_DIRS`
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
