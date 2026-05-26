#!/usr/bin/env node
import './config/bootstrap-env.mjs';
import path from 'node:path';
import {
  askWiki,
  compileWiki,
  initWiki,
  lintWiki,
  loadSourcesFromIntelStore,
} from 'js-wiki-engine';
import { createServices } from './bootstrap.mjs';
import { createApp } from './api/app.mjs';
import { getDb } from './storage/db.mjs';
import {
  createIntelStoreEngine,
  getIntelStoreEngine,
  resolveIntelBaseDir,
} from './storage/intel-store.mjs';
import {
  ResearchCancelledError,
  runCliResearch,
} from './cli-research-run.mjs';
import {
  applyResearchFlags,
  formatHistory,
  getDeepValue,
  parseArgs,
  setDeepValue,
} from './cli-utils.mjs';

const services = createServices(getDb());

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = error instanceof ResearchCancelledError ? 130 : 1;
});

async function main(argv) {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === 'help' || command === '--help') {
    printHelp();
    return;
  }

  if (command === 'research') {
    await researchCommand(rest);
    return;
  }

  if (command === 'config') {
    configCommand(rest);
    return;
  }

  if (command === 'history') {
    historyCommand(rest);
    return;
  }

  if (command === 'intel') {
    await intelCommand(rest);
    return;
  }

  if (command === 'wiki') {
    await wikiCommand(rest);
    return;
  }

  if (command === 'serve') {
    serveCommand(rest);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function researchCommand(argv) {
  const { args, flags } = parseArgs(argv);
  const query = args.join(' ').trim();
  if (!query) throw new Error('Usage: js-deepresearch-agent research "query"');

  const settings = settingsFromFlags(flags);
  const { result, artifacts } = await runCliResearch({
    query,
    settings,
    flags,
    services,
  });

  if (flags.json) {
    console.log(JSON.stringify({ ...result, artifacts }, null, 2));
  } else {
    console.log(result.report);
  }
}

function configCommand(argv) {
  const [subcommand, key, ...valueParts] = argv;
  const settings = services.settingsStore.get();

  if (!subcommand || subcommand === 'get') {
    const value = key ? getDeepValue(settings, key) : settings;
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (subcommand === 'set') {
    if (!key || valueParts.length === 0) {
      throw new Error('Usage: js-deepresearch-agent config set <key> <value>');
    }
    const updated = setDeepValue(settings, key, valueParts.join(' '));
    services.settingsStore.save(updated);
    console.log(`${key} updated.`);
    return;
  }

  throw new Error(`Unknown config command: ${subcommand}`);
}

function historyCommand(argv) {
  const [subcommand, id] = argv;
  if (!subcommand || subcommand === 'list') {
    console.log(formatHistory(services.researchRepository.list()));
    return;
  }

  if (subcommand === 'show') {
    const record = services.researchRepository.get(id);
    if (!record) throw new Error(`Research not found: ${id}`);
    console.log(record.report || record.error || 'No report available.');
    return;
  }

  throw new Error(`Unknown history command: ${subcommand}`);
}

async function intelCommand(argv) {
  const { args, flags } = parseArgs(argv);
  const subcommand = args[0] || 'list';

  if (flags.help || subcommand === 'help') {
    printIntelHelp();
    return;
  }

  const baseDir = flags['intel-dir'] || resolveIntelBaseDir();
  const engine = createIntelStoreEngine({ baseDir });

  if (subcommand === 'import') {
    const { importWorkDirSessions } = await import('../scripts/intel/import-work-dir-core.mjs');
    const summary = importWorkDirSessions({
      root: flags.root || 'work_dir',
      strategyFilter: flags.strategy || null,
      dryRun: Boolean(flags['dry-run']),
      skipExisting: !flags.force,
      upgradeExisting: Boolean(flags['upgrade-existing']),
      engine,
    });

    if (flags.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printIntelImportSummary(summary, baseDir);
    }
    return;
  }

  const {
    listArchivedRuns,
    showArchivedRun,
    listArchivedSources,
    listArchivedFindings,
  } = await import('../scripts/intel/inspect-core.mjs');
  const researchId = args[1];
  const limit = flags.limit ? Number(flags.limit) : 20;
  let payload;

  if (subcommand === 'list') {
    payload = listArchivedRuns(engine, { limit });
  } else if (subcommand === 'show') {
    if (!researchId) throw new Error('Usage: js-deepresearch-agent intel show <researchId>');
    payload = showArchivedRun(researchId, engine);
  } else if (subcommand === 'sources') {
    if (!researchId) throw new Error('Usage: js-deepresearch-agent intel sources <researchId>');
    payload = listArchivedSources(researchId, engine, { limit });
  } else if (subcommand === 'findings') {
    if (!researchId) throw new Error('Usage: js-deepresearch-agent intel findings <researchId>');
    payload = listArchivedFindings(researchId, engine, { limit });
  } else {
    throw new Error(`Unknown intel command: ${subcommand}`);
  }

  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printIntelPayload(subcommand, payload, baseDir);
  }
}

async function wikiCommand(argv) {
  const { args, flags } = parseArgs(argv);
  const subcommand = args[0] || 'compile';

  if (flags.help || subcommand === 'help') {
    printWikiHelp();
    return;
  }

  const vaultDir = path.resolve(flags.vault || 'wiki');

  if (subcommand === 'init') {
    const result = initWiki({
      vaultDir,
      initObsidianConfig: Boolean(flags['init-obsidian-config']),
    });
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Initialized wiki vault: ${result.vaultDir}`);
    }
    return;
  }

  if (subcommand === 'compile') {
    const engine = getIntelStoreEngine();
    const researchId = await resolveWikiResearchId(engine, flags['research-id']);
    initWiki({
      vaultDir,
      initObsidianConfig: Boolean(flags['init-obsidian-config']),
    });

    const loaded = loadSourcesFromIntelStore({ engine, researchId });
    const summary = compileWiki({
      vaultDir,
      sources: loaded.sources,
      report: loaded.report,
      meta: loaded.meta,
      force: Boolean(flags.force || flags.full),
    });

    let lintResult = null;
    if (flags.lint) {
      lintResult = lintWiki({ vaultDir });
    }

    const payload = { researchId, ...summary, lint: lintResult };
    if (flags.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      printWikiCompileSummary(payload);
    }

    if (lintResult && !lintResult.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (subcommand === 'lint') {
    const result = lintWiki({ vaultDir });
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Lint: ${result.errorCount} error(s), ${result.warnCount} warn(s)`);
      console.log(`Lint report: ${result.reportPath}`);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (subcommand === 'ask') {
    const question = args.slice(1).join(' ').trim();
    if (!question) throw new Error('Usage: js-deepresearch-agent wiki ask "question"');
    const result = await askWiki({
      vaultDir,
      question,
      limit: flags.limit ? Number(flags.limit) : 5,
    });
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.answer);
      for (const page of result.pages) {
        console.log(`- ${page.relativePath}  score=${page.score}`);
      }
    }
    return;
  }

  throw new Error(`Unknown wiki command: ${subcommand}`);
}

function serveCommand(argv) {
  const { flags } = parseArgs(argv);
  const port = Number(flags.port || process.env.PORT || 3000);
  const app = createApp(getDb());
  app.listen(port, () => {
    console.log(`js-deepresearch-agent listening on http://127.0.0.1:${port}`);
  });
}

function settingsFromFlags(flags) {
  return applyResearchFlags(services.settingsStore.get(), flags);
}

async function resolveWikiResearchId(engine, researchId) {
  if (researchId) return researchId;
  const { listArchivedRuns } = await import('../scripts/intel/inspect-core.mjs');
  const runs = listArchivedRuns(engine, { limit: 1 });
  if (!runs.length) {
    throw new Error('No archived research runs found in intel store');
  }
  return runs[0].researchId;
}

function printIntelImportSummary(summary, baseDir) {
  const mode = summary.dryRun ? 'dry-run' : 'import';
  console.log(`Intel store ${mode} (${baseDir})`);
  console.log(`Scanned: ${summary.scanned}  Imported: ${summary.imported}  Upgraded: ${summary.upgraded ?? 0}  Skipped: ${summary.skipped}  Failed: ${summary.failed}`);
  for (const item of summary.items) {
    const id = item.researchId ? `  id=${item.researchId}` : '';
    const reason = item.reason ? `  (${item.reason})` : '';
    console.log(`- [${item.status}] ${item.strategy}/${item.timestamp}${id}${reason}`);
  }
}

function printIntelPayload(command, payload, baseDir) {
  if (command === 'list') {
    if (!payload.length) {
      console.log(`No archived research runs in ${baseDir}.`);
      return;
    }
    console.log(`Archived runs (${baseDir}):`);
    for (const run of payload) {
      console.log([
        run.researchId,
        run.strategy,
        `sources=${run.sourcesCount}`,
        `findings=${run.findingsCount}`,
        run.query,
      ].join('  |  '));
    }
    return;
  }

  if (command === 'show') {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`${command} (${payload.length} shown):`);
  for (const row of payload) {
    console.log(JSON.stringify(row));
  }
}

function printWikiCompileSummary(payload) {
  console.log(`Compiled wiki for ${payload.researchId}`);
  console.log(`Vault: ${payload.vaultDir}`);
  console.log(`Pages written: ${payload.compiled}, skipped: ${payload.skipped}`);
  console.log(`Topics: ${payload.topics.join(', ') || '(none)'}`);
  if (payload.lint) {
    console.log(`Lint: ${payload.lint.errorCount} error(s), ${payload.lint.warnCount} warn(s)`);
    console.log(`Lint report: ${payload.lint.reportPath}`);
  }
}

function printHelp() {
  console.log(`
js-deepresearch-agent

Commands:
  research "query" [--search js-eyes|searxng] [--search-skills skillA,skillB] [--js-eyes-skill skillA,skillB] [--search-server-url ws://localhost:18080] [--search-base-url http://127.0.0.1:8080] [--strategy source-based|rapid|parallel] [--iterations 2] [--questions 3] [--concurrency 2] [--work-dir work_dir] [--output report.md] [--json] [--no-save] [--no-work-dir]
    Press Ctrl+C once to cancel gracefully; press again to force exit.
  config get [key]
  config set <key> <value>
  history [list]
  history show <researchId>
  intel list [--limit 20] [--intel-dir data/intel] [--json]
  intel show <researchId> [--json]
  intel sources <researchId> [--limit 20] [--json]
  intel findings <researchId> [--limit 20] [--json]
  intel import [--root work_dir] [--strategy source-based] [--dry-run] [--force] [--upgrade-existing] [--json]
  wiki init [--vault wiki] [--init-obsidian-config]
  wiki compile [--research-id <id>] [--vault wiki] [--force] [--lint] [--json]
  wiki lint [--vault wiki] [--json]
  wiki ask "question" [--vault wiki] [--limit 5] [--json]
  serve [--port 3000]
`);
}

function printIntelHelp() {
  console.log(`
js-deepresearch-agent intel

Commands:
  intel list                     List archived research runs
  intel show <researchId>        Show one archived run
  intel sources <researchId>     List sources for a run
  intel findings <researchId>    List findings for a run
  intel import                   Import historical work_dir sessions

Options:
  --intel-dir <dir>              Intel store base dir
  --limit <n>                    Limit rows for list/sources/findings
  --root <dir>                   Work_dir root for import
  --strategy <name>              Import only one strategy
  --dry-run                      Preview import
  --force                        Re-import existing runs
  --upgrade-existing             Re-archive existing runs from work_dir with inline report and metadata
  --json                         JSON output
`);
}

function printWikiHelp() {
  console.log(`
js-deepresearch-agent wiki

Commands:
  wiki init                      Initialize an Obsidian-compatible vault
  wiki compile                   Compile intel-store artifacts into a vault
  wiki lint                      Check wikilinks and manifest references
  wiki ask "question"            Deterministic retrieval over vault pages

Options:
  --research-id <id>             Research run id for compile (default: latest)
  --vault <dir>                  Vault directory (default: wiki)
  --force, --full                Recompile all sources
  --lint                         Run lint after compile
  --init-obsidian-config         Write minimal .obsidian/app.json
  --limit <n>                    Limit ask results
  --json                         JSON output
`);
}
