#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  FileRunRecorder,
  ResearchRunner,
  createWorkSessionDir,
  saveResearchArtifacts,
} from 'js-deepresearch-engine';
import { parseArgs, applyResearchFlags } from '../src/cli-utils.mjs';
import { requireProgramVerification } from './benchmark/quality/program-verification.mjs';
import { assertIsolatedOutput } from './benchmark/quality/artifact-verification.mjs';
import { QUALITY_COMMANDS, requireInspectionMode, routeQualityCommand } from './benchmark/quality-command-router.mjs';
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
  if (await routeQualityCommand(argv)) return;
  const { args, flags } = parseArgs(argv);

  if (flags.help || !argv.length) {
    printHelp();
    return;
  }
  requireInspectionMode(flags);

  if (flags.run) {
    if (typeof flags.run !== 'string' || !flags.run.trim()) throw new Error('--run requires a non-empty query string.');
    if (args.length || flags.sessions || flags['work-dirs'] || flags['research-ids']) throw new Error('--run cannot be combined with existing-result targets.');
    const query = flags.run.trim();

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
  return compareStrategySessions({
    sessions,
    researchIds,
    strictPlatform: flags['strict-platform'] || null,
    wallClockByWorkDir,
  });
}

export async function runStrategyBenchmark({
  query,
  presets,
  flags,
  runner = new ResearchRunner(),
  saveArtifacts = saveResearchArtifacts,
  onProgress = () => {},
}) {
  if (flags['no-work-dir']) {
    throw new Error('--run mode requires work_dir artifacts. Remove --no-work-dir.');
  }
  if (!flags['program-verification']) throw new Error('STRATEGY_RUN_REQUIRES_PROGRAM_VERIFICATION');
  requireProgramVerification(flags['program-verification']);
  await import('../src/config/bootstrap-env.mjs');
  const { createServices } = await import('../src/bootstrap.mjs');
  const { getDb, closeDb } = await import('../src/storage/db.mjs');
  const services = createServices(getDb());
  const baseSettings = applyResearchFlags(services.settingsStore.get(), flags);
  closeDb();
  const sessions = [];
  const wallClockByWorkDir = new Map();

  for (const preset of presets) {
    const settings = applyStrategyPreset(baseSettings, preset);
    onProgress(`Running ${preset.label}...`);

    const sessionDir = createWorkSessionDir({ settings, strategy: preset.strategy });
    const recorder = new FileRunRecorder({
      sessionDir,
      strategy: preset.strategy,
      query,
      metadata: { settings, benchmarkPreset: preset.label },
    });
    const startedAt = Date.now();
    let result;
    try {
      result = await runner.run({
        query,
        settings,
        recorder,
        onProgress: ({ message, progress, level }) => {
          if (!flags.json) {
            console.error(`[${level}] ${progress ?? '-'}% ${message}`);
          }
        },
      });
    } catch (error) {
      recorder.finalize('failed', { error });
      throw error;
    }
    const wallClockDurationMs = Date.now() - startedAt;

    const artifacts = saveArtifacts({
      sessionDir,
      settings,
      strategy: preset.strategy,
      query,
      result,
    });
    recorder.finalize('completed', {
      artifacts: {
        reportPath: artifacts.reportPath,
        findingsPath: artifacts.findingsPath,
        sourcesPath: artifacts.sourcesPath,
        metaPath: artifacts.metaPath,
      },
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
    assertIsolatedOutput(flags.output, comparison.runs.map(run => run.benchmark?.artifactVerification?.resultPin?.sessionDir || run.workDir));
    fs.writeFileSync(flags.output, output, 'utf8');
    if (!flags.json) {
      console.error(`Comparison written to ${flags.output}`);
    }
  }

  console.log(output);
}

function printHelp() {
  console.log(`
Strategy comparison (versioned artifacts, recorded cost, runtime diagnostics)

Usage:
  node scripts/benchmark-strategies.mjs --sessions <dir1,dir2,...> [options]
  node scripts/benchmark-strategies.mjs --research-ids <id1,id2,...> [options]
  node scripts/benchmark-strategies.mjs --run "your query" [options]

Modes:
  --sessions <paths>       Compare existing work_dir sessions (comma-separated)
                           Optional label prefix: exploratory=work_dir/exploratory/...
  --research-ids <ids>     Compare archived intel store runs
  --run <query>            Run multiple strategies, then inspect; requires --program-verification

Shared quality subcommands:
  ${QUALITY_COMMANDS.join(', ')}
  Use score --mode model-observation with a campaign, gold and program verification
  for independent quality observations, or compare --baseline / --candidate for paired scores.

Strategy presets (--strategies, for --run only):
  quick, focused, exploratory
  Default: ${DEFAULT_STRATEGY_COMPARE_ORDER.join(',')}

Options:
  --json                   JSON output
  --output <file>          Write report to file
  --no-llm                 Compatibility alias; existing-result comparison is always offline
  --program-verification  Current verification record required before --run
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
    --program-verification <record> --json
`);
}
