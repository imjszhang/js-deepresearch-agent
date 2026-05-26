#!/usr/bin/env node
import { parseArgs } from '../../src/cli-utils.mjs';
import { createIntelStoreEngine, resolveIntelBaseDir } from '../../src/storage/intel-store.mjs';
import {
  listArchivedRuns,
  showArchivedRun,
  listArchivedSources,
  listArchivedFindings,
} from './inspect-core.mjs';

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
}

function main(argv) {
  const { args, flags } = parseArgs(argv);
  const command = args[0] || 'list';
  const researchId = args[1];
  const baseDir = flags['intel-dir'] || resolveIntelBaseDir();
  const engine = createIntelStoreEngine({ baseDir });
  const limit = flags.limit ? Number(flags.limit) : 20;

  if (flags.help) {
    printHelp();
    return;
  }

  let payload;

  switch (command) {
    case 'list':
      payload = listArchivedRuns(engine, { limit });
      if (!payload.length) {
        if (flags.json) {
          console.log(JSON.stringify({ runs: [], message: 'No archived research runs found.' }, null, 2));
        } else {
          console.log(`No archived research runs in ${baseDir}.`);
        }
        return;
      }
      break;
    case 'show':
      if (!researchId) throw new Error('Usage: node scripts/intel/inspect.mjs show <researchId>');
      payload = showArchivedRun(researchId, engine);
      break;
    case 'sources':
      if (!researchId) throw new Error('Usage: node scripts/intel/inspect.mjs sources <researchId>');
      payload = listArchivedSources(researchId, engine, { limit });
      break;
    case 'findings':
      if (!researchId) throw new Error('Usage: node scripts/intel/inspect.mjs findings <researchId>');
      payload = listArchivedFindings(researchId, engine, { limit });
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }

  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printText(command, payload, baseDir);
}

function printText(command, payload, baseDir) {
  if (command === 'list') {
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

function printHelp() {
  console.log(`
Inspect archived research runs in js-intel-store.

Usage:
  node scripts/intel/inspect.mjs <command> [researchId] [options]

Commands:
  list                     List archived runs (default)
  show <researchId>        Show one run summary
  sources <researchId>     List sources for a run
  findings <researchId>    List findings for a run

Options:
  --intel-dir <dir>        Intel store base dir
  --limit <n>              Limit rows (default: 20)
  --json                   JSON output
  --help                   Show this help

Examples:
  npm run intel:inspect -- list
  npm run intel:inspect -- show imported__source-based__2026-05-26_065414
  npm run intel:inspect -- sources imported__source-based__2026-05-26_065414 --limit 5
`);
}
