#!/usr/bin/env node
import './config/bootstrap-env.mjs';
import path from 'node:path';
import {
  loadRecordedCallExchange,
  replayRecordedLlmCall,
} from 'js-deepresearch-engine';
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
  runCliResearchResume,
} from './cli-research-run.mjs';
import {
  applyResearchFlags,
  formatHistory,
  getDeepValue,
  parseArgs,
  parseResumeExploreFlags,
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

  if (command === 'replay') {
    await replayCommand(rest);
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
  if (flags.resume) {
    if (flags['planning-context']) throw new Error('Research --resume cannot change planning context; start a new run.');
    if (flags.resume === true) {
      throw new Error('Usage: js-deepresearch-agent research --resume <sessionDir>');
    }
    if (query) {
      throw new Error('Research --resume cannot be combined with a new query.');
    }
    const settings = settingsFromFlags(flags);
    const resumeExplore = parseResumeExploreFlags(flags);
    const { result, artifacts, delivery, exitCode } = await runCliResearchResume({
      sessionDir: flags.resume,
      settings,
      flags,
      resumeExplore,
      services,
    });
    process.exitCode = exitCode;
    if (flags.json) {
      console.log(JSON.stringify({ ...result, artifacts, delivery }, null, 2));
    } else {
      console.log(result.report);
    }
    return;
  }
  if (!query) throw new Error('Usage: js-deepresearch-agent research "query" | --resume <sessionDir>');

  const settings = settingsFromFlags(flags);
  const { result, artifacts, delivery, exitCode } = await runCliResearch({
    query,
    settings,
    flags,
    services,
  });

  process.exitCode = exitCode;
  if (flags.json) {
    console.log(JSON.stringify({ ...result, artifacts, delivery }, null, 2));
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

async function replayCommand(argv) {
  const { args, flags } = parseArgs(argv);
  const sessionDir = args[0];
  const callId = flags.call;
  const live = Boolean(flags.live);
  const offline = Boolean(flags.offline);
  if (!sessionDir || !callId || live === offline) {
    throw new Error('Usage: js-deepresearch-agent replay <sessionDir> --call <llm-call-id> (--live|--offline) [--json]');
  }
  if (offline) {
    const exchange = loadRecordedCallExchange({ sessionDir, callId });
    if (flags.json) {
      console.log(JSON.stringify(exchange, null, 2));
      return;
    }
    const text = exchange.result?.response?.text;
    if (text !== undefined && text !== null) {
      console.log(text);
      return;
    }
    console.log(JSON.stringify(exchange.result, null, 2));
    return;
  }
  const result = await replayRecordedLlmCall({
    sessionDir,
    callId,
    settings: settingsFromFlags(flags),
  });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.response.text);
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
      claims: loaded.claims,
      passages: loaded.passages,
      gaps: loaded.gaps,
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
        `passages=${run.passagesCount ?? 0}`,
        `claims=${run.claimsCount ?? 0}`,
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
  research "query" [--search local|js-eyes|searxng] [--corpus-dirs dir1,dir2] [--search-skills skillA,skillB] [--search-server-url ws://localhost:18080] [--strategy focused|quick|exploratory] [--iterations 1] [--questions 2] [--concurrency 1] [--max-search-requests 0] [--max-source-reads 0] [--focused-iteration-control true|false] [--focused-query-memory true|false] [--focused-evidence-passages true|false] [--focused-claim-alignment true|false] [--focused-pre-report-gate true|false] [--work-dir work_dir] [--output report.md] [--json] [--no-save] [--no-work-dir]
  research --resume <sessionDir> [--continue-explore --resume-extra-steps n] [--resume-extra-searches n] [--resume-extra-reads n] [--output report.md] [--json] [--no-save]
    Strategies: focused (default, 专题调研) | quick (快速调研, default 1 iteration) | exploratory (探索性调研)
    Local search: --search local --corpus-dirs ~/notes,~/reports  (each directory is an independent channel; #16 fan-out with web engines is not in this command)
    Budgets (focused/quick counts): --max-llm-tokens 0 --max-search-requests 0 --max-source-reads 0 --max-rerank-requests 0 --max-rerank-tokens 0
    Report: --report-max-output-tokens 0 (0 = no app cap; --reserve-report-tokens is a deprecated alias)
    Optional total fuse: --max-total-llm-tokens 0 (exploration + report; default unlimited)
    Optional rerank: --rerank-provider rules|disabled|jina|http|local --rerank-model <name> --rerank-base-url <url> --rerank-api-key <key> --rerank-timeout-ms 30000
    Planning hints: --planning-context <json-file> (questions, identityHints, readingHints; soft suggestions only)
    Relevance gate: --read-relevance-enabled true|false --read-relevance-min-score 0.01 --read-body-relevance true|false --site-query-mode confirmed|always|never
    Read transport: --read-host-circuit-threshold 3 --read-response-headers-timeout-ms 10000 --read-html-timeout-ms 15000 --read-document-timeout-ms 60000
    Content cache: --no-cache --cache-dir data/content-cache
    Search options (passed through to SearXNG; no language/engine routing is applied by this CLI): --search-language zh --search-engines google,brave --search-categories general
    Optional source assessment extra call in full/extract: --source-assessment true
    Focused: --focused-fetch-mode summary|disabled|full|extract --focused-fetch-backend auto|http|js-eyes --focused-max-urls 12 --focused-cluster-results true|false --focused-max-per-hostname 2
    Evidence HTTP: --http2 true|false --http-cookie-retry true|false --http-max-response-bytes 10485760 --http-allowed-content-types text/html,application/pdf --http-host-headers '{"example.com":{"Referer":"https://search.example/"}}'
      Host header overrides are exact-host (or *.example.com) browser-header tuning only; Cookie/Authorization/framing headers are rejected.
    Exploratory: --exploratory-max-steps 0 --exploratory-max-reads-per-step 4 --exploratory-min-llm-tokens 600000 --exploratory-max-llm-tokens 1000000 --exploratory-max-search-requests 0 --exploratory-max-source-reads 0 --max-repair-failures-per-gap 3 --max-consecutive-invalid-steps 6
    On --strategy exploratory, --max-search-requests / --max-source-reads write exploratory count caps (default 0 = unlimited) and do not inherit global budget counts.
    Resume: --resume <sessionDir> writes the report when a pre-report checkpoint exists. An unfinished exploratory-step-complete (no loop-complete) continues the loop. After a finished loop, --continue-explore requires --resume-extra-steps <n> (n>=1); optional --resume-extra-searches / --resume-extra-reads raise count caps.
    Search preflight: first search is blocked until js-eyes or SearXNG answers a short reachability probe. Failed js-eyes probe: run "js-eyes doctor --json".
    Press Ctrl+C once to cancel gracefully; press again to force exit.
  config get [key]
  config set <key> <value>
  history [list]
  history show <researchId>
  replay <sessionDir> --call <llm-call-id> (--live|--offline) [--json]
  intel list [--limit 20] [--intel-dir data/intel] [--json]
  intel show <researchId> [--json]
  intel sources <researchId> [--limit 20] [--json]
  intel findings <researchId> [--limit 20] [--json]
  intel import [--root work_dir] [--strategy focused] [--dry-run] [--force] [--upgrade-existing] [--json]
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
