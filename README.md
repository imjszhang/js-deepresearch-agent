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
npm exec jdr -- help
npm exec jdr -- config get
npm exec jdr -- config set llm.apiKey "YOUR_API_KEY"
npm exec jdr -- config set search.baseUrl "http://127.0.0.1:8080"
npm exec jdr -- research "Explain the current state of local-first AI research" --output report.md
npm exec jdr -- history list
```

You can also override settings for one run:

```bash
npm exec jdr -- research "Compare SearXNG and Brave Search APIs" \
  --provider openai-compatible \
  --model gpt-4o-mini \
  --base-url https://api.openai.com/v1 \
  --search-base-url http://127.0.0.1:8080
```

## Configuration

Runtime settings are stored in the local SQLite database under `data/`. Values from `.env` are loaded automatically on startup and override saved settings when present. The default settings are:

- LLM provider: `openai-compatible`
- LLM model: `gpt-4o-mini`
- LLM base URL: `https://api.openai.com/v1`
- Search engine: `searxng`
- Search base URL: `http://127.0.0.1:8080`

SearXNG is the only implemented search adapter in this MVP. DuckDuckGo, Tavily, and Brave Search are represented in the adapter metadata for later implementation.

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

Do not commit API keys or local database files. `.env.example` documents common local values.

## Scripts

- `npm run dev` starts the Vite frontend dev server.
- `npm run server` starts the Express API and serves the built frontend.
- `npm run build` builds the web UI into `dist/`.
- `npm test` runs the Node test suite.
- `npm run lint` runs ESLint.

## Project Structure

```text
src/
  api/        Express app and HTTP routes
  config/     Default settings and persistence
  jobs/       Research job orchestration
  llm/        LLM provider adapters
  research/   Research strategies and report building
  search/     Search engine adapters
  storage/    SQLite repositories and migrations
web/          Vite frontend
tests/        Node test suite
```

## Git Hygiene

Generated files and local runtime state are intentionally ignored:

- `node_modules/`
- `dist/`
- `data/`
- `.env`

Run `npm run lint` and `npm test` before opening a pull request.
