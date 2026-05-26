#!/usr/bin/env node
import '../src/config/bootstrap-env.mjs';
import { createLlmProvider } from 'js-deepresearch-engine';
import { parseArgs } from '../src/cli-utils.mjs';
import { createServices } from '../src/bootstrap.mjs';
import { getDb } from '../src/storage/db.mjs';
import { runBenchmark } from './benchmark/run-benchmark.mjs';
import { formatJsonSummary, formatMarkdownSummary } from './benchmark/format-output.mjs';

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main(argv) {
  const { args, flags } = parseArgs(argv);

  if (flags.help) {
    printHelp();
    return;
  }

  const workDir = args[0];
  if (!workDir) {
    throw new Error('Usage: node scripts/benchmark-research.mjs <work-dir> [--json] [--no-llm] [--strict-platform js-eyes:zhihu]');
  }

  const llmEnabled = !flags['no-llm'];
  let llm = null;

  if (llmEnabled) {
    const settings = createServices(getDb()).settingsStore.get();
    if (settings.llm?.apiKey || settings.llm?.provider === 'ollama') {
      llm = createLlmProvider(settings);
    }
  }

  const result = await runBenchmark({
    workDir,
    strictPlatform: flags['strict-platform'] || null,
    llm,
    llmEnabled,
  });

  if (flags.json) {
    console.log(formatJsonSummary(result));
  } else {
    console.log(formatMarkdownSummary(result));
  }
}

function printHelp() {
  console.log(`
Research source-matching benchmark

Usage:
  node scripts/benchmark-research.mjs <work-dir> [--json] [--no-llm] [--strict-platform js-eyes:zhihu]

Examples:
  node scripts/benchmark-research.mjs work_dir/source-based/2026-05-26_043125
  node scripts/benchmark-research.mjs work_dir/source-based/2026-05-26_043125 --no-llm --json
  node scripts/benchmark-research.mjs work_dir/source-based/2026-05-26_043125 --strict-platform js-eyes:zhihu
`);
}
