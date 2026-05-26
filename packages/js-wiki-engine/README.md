# js-wiki-engine

Obsidian-compatible LLM Wiki compiler for research artifacts.

## Features

- Initialize an Obsidian vault (`Home.md`, `Map of Content.md`, templates)
- Compile normalized sources into `Sources/`, `Topics/`, `Claims/`
- Wikilinks + YAML frontmatter for Obsidian graph/search
- `manifest.json` for incremental source compilation
- Basic `lintWiki()` and `askWiki()` (deterministic MVP)

## Usage

```javascript
import {
  initWiki,
  compileWiki,
  lintWiki,
  askWiki,
  loadSourcesFromIntelStore,
} from 'js-wiki-engine';
import { createIntelStoreEngine } from 'js-intel-store';

const vaultDir = './wiki';
initWiki({ vaultDir });

const engine = createIntelStoreEngine({ baseDir: './data/intel' });
const { sources, report, meta } = await loadSourcesFromIntelStore({ engine, researchId: '...' });

await compileWiki({ vaultDir, sources, report, meta });
const lint = lintWiki({ vaultDir });
const ask = askWiki({ vaultDir, question: 'What is LLM Wiki?' });
```

## CLI (host app)

From `js-deepresearch-agent`:

```bash
npm run wiki:compile -- --research-id <id> --vault wiki
```
