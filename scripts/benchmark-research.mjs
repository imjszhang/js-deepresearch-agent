#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import '../src/config/bootstrap-env.mjs';
import { createLlmProvider } from 'js-deepresearch-engine';
import { parseArgs } from '../src/cli-utils.mjs';
import { createServices } from '../src/bootstrap.mjs';
import { getDb } from '../src/storage/db.mjs';
import { runBenchmark } from './benchmark/run-benchmark.mjs';
import { formatJsonSummary, formatMarkdownSummary } from './benchmark/format-output.mjs';
import { resolveBenchmarkTarget } from './benchmark/resolve-target.mjs';

const isCliEntry = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isCliEntry) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main(argv) {
  const { args, flags } = parseArgs(argv);

  if (flags.help) {
    printHelp();
    return;
  }

  const { workDir, researchId } = resolveBenchmarkTarget({ args, flags });

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
    researchId,
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
  node scripts/benchmark-research.mjs <work-dir> [options]
  node scripts/benchmark-research.mjs --research-id <id> [options]

Options:
  --research-id <id>       Load artifacts from js-intel-store by researchId
  --json                   JSON output
  --no-llm                 Disable LLM judge
  --strict-platform <id>   e.g. js-eyes:zhihu

Examples:
  node scripts/benchmark-research.mjs work_dir/source-based/2026-05-26_043125
  node scripts/benchmark-research.mjs --research-id imported__source-based__2026-05-26_065414 --no-llm
  node scripts/benchmark-research.mjs work_dir/source-based/2026-05-26_043125 --no-llm --json
`);
}
