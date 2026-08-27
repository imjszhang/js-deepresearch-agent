#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import '../src/config/bootstrap-env.mjs';
import { ResearchRunner, createLlmProvider, saveResearchToWorkDir } from 'js-deepresearch-engine';
import { parseArgs, applyResearchFlags } from '../src/cli-utils.mjs';
import { createServices } from '../src/bootstrap.mjs';
import { getDb } from '../src/storage/db.mjs';
import { compareStrategySessions } from './benchmark/compare-strategies.mjs';
import {
  DEFAULT_STRATEGY_COMPARE_ORDER,
  applyStrategyPreset,
  parseStrategyList,
} from './benchmark/strategy-presets.mjs';
import {
  formatStrategyCompareJson,
  formatStrategyCompareMarkdown,
} from './benchmark/format-strategy-compare.mjs';

const isCliEntry = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isCliEntry) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export async function main(argv) {
  const { args, flags } = parseArgs(argv);

  if (flags.help) {
    printHelp();
    return;
  }

  if (flags.run) {
    const query = String(flags.run).trim();
    if (!query) throw new Error('--run requires a non-empty query string.');

    const presets = parseStrategyList(flags.strategies);
    const { sessions, wallClockByWorkDir } = await runStrategyBenchmark({
      query,
      presets,
      flags,
      onProgress: (message) => {
        if (!flags.json) console.error(`[benchmark] ${message}`);
      },
    });

    const comparison = await buildComparison({
      sessions,
      wallClockByWorkDir,
      flags,
    });
    outputComparison(comparison, flags);
    return;
  }

  const sessions = parseList(flags.sessions || flags['work-dirs'] || args[0]);
  const researchIds = parseList(flags['research-ids']);

  if (sessions.length + researchIds.length < 2) {
    throw new Error('Provide at least two --sessions paths, --research-ids, or positional work dirs.');
  }

  const comparison = await buildComparison({
    sessions,
    researchIds,
    flags,
  });
  outputComparison(comparison, flags);
}

async function buildComparison({
  sessions = [],
  researchIds = [],
  wallClockByWorkDir = new Map(),
  flags,
}) {
  const llmEnabled = !flags['no-llm'];
  let llm = null;

  if (llmEnabled) {
    const settings = createServices(getDb()).settingsStore.get();
    if (settings.llm?.apiKey || settings.llm?.provider === 'ollama') {
      llm = createLlmProvider(settings);
    }
  }

  return compareStrategySessions({
    sessions,
    researchIds,
    strictPlatform: flags['strict-platform'] || null,
    llm,
    llmEnabled,
    wallClockByWorkDir,
  });
}

export async function runStrategyBenchmark({
  query,
  presets,
  flags,
  runner = new ResearchRunner(),
  saveArtifacts = saveResearchToWorkDir,
  onProgress = () => {},
}) {
  const services = createServices(getDb());
  let baseSettings = applyResearchFlags(services.settingsStore.get(), flags);
  const sessions = [];
  const wallClockByWorkDir = new Map();

  for (const preset of presets) {
    const settings = applyStrategyPreset(baseSettings, preset);
    onProgress(`Running ${preset.label}...`);

    const startedAt = Date.now();
    const result = await runner.run({
      query,
      settings,
      onProgress: ({ message, progress, level }) => {
        if (!flags.json) {
          console.error(`[${level}] ${progress ?? '-'}% ${message}`);
        }
      },
    });
    const wallClockDurationMs = Date.now() - startedAt;

    if (flags['no-work-dir']) {
      throw new Error('--run mode requires work_dir artifacts. Remove --no-work-dir.');
    }

    const artifacts = saveArtifacts({
      settings,
      strategy: preset.strategy,
      query,
      result,
    });
    wallClockByWorkDir.set(artifacts.sessionDir, wallClockDurationMs);
    sessions.push(`${preset.label}=${artifacts.sessionDir}`);
    onProgress(`Finished ${preset.label} in ${wallClockDurationMs}ms -> ${artifacts.sessionDir}`);
  }

  return { sessions, wallClockByWorkDir };
}

function parseList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function outputComparison(comparison, flags) {
  const output = flags.json
    ? formatStrategyCompareJson(comparison)
    : formatStrategyCompareMarkdown(comparison);

  if (flags.output) {
    fs.writeFileSync(flags.output, output, 'utf8');
    if (!flags.json) {
      console.error(`Comparison written to ${flags.output}`);
    }
  }

  console.log(output);
}

function printHelp() {
  console.log(`
Strategy benchmark comparison (quality, time, cost, strategy contract)

Usage:
  node scripts/benchmark-strategies.mjs --sessions <dir1,dir2,...> [options]
  node scripts/benchmark-strategies.mjs --research-ids <id1,id2,...> [options]
  node scripts/benchmark-strategies.mjs --run "your query" [options]

Modes:
  --sessions <paths>       Compare existing work_dir sessions (comma-separated)
                           Optional label prefix: exploratory=work_dir/exploratory/...
  --research-ids <ids>     Compare archived intel store runs
  --run <query>            Run multiple strategies on the same query, then compare

Strategy presets (--strategies, for --run only):
  quick, focused, exploratory
  Default: ${DEFAULT_STRATEGY_COMPARE_ORDER.join(',')}

Options:
  --json                   JSON output
  --output <file>          Write report to file
  --no-llm                 Use stored/schema-v3 evaluations only
  --strict-platform <id>   e.g. js-eyes:zhihu
  --strategies <list>      Comma-separated presets for --run mode

Research flags (for --run):
  Same flags as \`jdr research\` (provider, model, search, iterations, budget, rerank, etc.)

Examples:
  node scripts/benchmark-strategies.mjs \\
    --sessions work_dir/focused/2026-07-13_051140,work_dir/exploratory/2026-07-13_051626 \\
    --no-llm --output tmp/strategy-compare.md

  node scripts/benchmark-strategies.mjs \\
    --run "Ollama vs llama.cpp for local LLM deployment" \\
    --strategies quick,focused,exploratory \\
    --no-llm --json
`);
}
