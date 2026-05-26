#!/usr/bin/env node
import { parseArgs } from '../../src/cli-utils.mjs';
import { createIntelStoreEngine, resolveIntelBaseDir } from '../../src/storage/intel-store.mjs';
import { importWorkDirSessions } from './import-work-dir-core.mjs';

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
}

function main(argv) {
  const { flags } = parseArgs(argv);

  if (flags.help) {
    printHelp();
    return;
  }

  const baseDir = flags['intel-dir'] || resolveIntelBaseDir();
  const engine = createIntelStoreEngine({ baseDir });
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
    return;
  }

  printTextSummary(summary, baseDir);
}

function printTextSummary(summary, baseDir) {
  const mode = summary.dryRun ? 'dry-run' : 'import';
  console.log(`Intel store ${mode} (${baseDir})`);
  console.log(`Scanned: ${summary.scanned}  Imported: ${summary.imported}  Upgraded: ${summary.upgraded ?? 0}  Skipped: ${summary.skipped}  Failed: ${summary.failed}`);

  for (const item of summary.items) {
    const id = item.researchId ? `  id=${item.researchId}` : '';
    const reason = item.reason ? `  (${item.reason})` : '';
    console.log(`- [${item.status}] ${item.strategy}/${item.timestamp}${id}${reason}`);
  }
}

function printHelp() {
  console.log(`
Import historical work_dir research artifacts into js-intel-store.

Usage:
  node scripts/intel/import-work-dir.mjs [options]

Options:
  --root <dir>         Work directory root (default: work_dir)
  --strategy <name>    Only import one strategy (e.g. source-based)
  --intel-dir <dir>    Intel store base dir (default: data/intel or JDR_INTEL_STORE_DIR)
  --dry-run            List sessions that would be imported
  --force              Re-import even if run already exists (updates run metadata; may append findings)
  --upgrade-existing   Re-archive existing runs from work_dir to add inline report and metadata
  --json               Machine-readable summary
  --help               Show this help

Examples:
  npm run intel:import -- --dry-run
  npm run intel:import -- --strategy source-based
  npm run intel:import -- --json
`);
}
