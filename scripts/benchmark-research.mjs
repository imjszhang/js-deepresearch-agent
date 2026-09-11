#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../src/cli-utils.mjs';
import { runBenchmark } from './benchmark/run-benchmark.mjs';
import { formatJsonSummary, formatMarkdownSummary } from './benchmark/format-output.mjs';
import { resolveBenchmarkTarget } from './benchmark/resolve-target.mjs';
import { QUALITY_COMMANDS, requireInspectionMode, routeQualityCommand } from './benchmark/quality-command-router.mjs';

export async function main(argv) {
  if (await routeQualityCommand(argv)) return;
  const { args, flags } = parseArgs(argv);
  if (flags.help || !argv.length) { printHelp(); return; }
  requireInspectionMode(flags);

  if (flags.compare) {
    if (args.length || flags['research-id']) throw new Error('Use --compare without another inspection target.');
    const ids = String(flags.compare).split(',').map(id => id.trim()).filter(Boolean);
    if (ids.length < 2 || new Set(ids).size !== ids.length) throw new Error('--compare requires at least two distinct research IDs');
    const runs = [];
    for (const researchId of ids) runs.push(await runBenchmark({ researchId, strictPlatform: flags['strict-platform'] || null }));
    const queries = new Set(runs.map(run => run.query));
    const comparison = { schemaVersion: 2, origin: 'program_check', scope: 'declared_artifact_integrity',
      query: queries.size === 1 ? runs[0].query : null,
      warnings: queries.size === 1 ? [] : ['Compared runs have different queries; no semantic quality comparison was performed.'],
      plannedRuns: runs.length, verifiedRuns: runs.filter(run => run.artifactVerification.status === 'passed').length,
      modelObservedRuns: 0, runs };
    console.log(flags.json ? JSON.stringify(comparison, null, 2)
      : runs.map(run => formatMarkdownSummary(run)).join('\n'));
    return;
  }
  if (args.length > 1) throw new Error('Provide one work directory, or use a quality subcommand.');
  const target = resolveBenchmarkTarget({ args, flags });
  const result = await runBenchmark({ ...target, strictPlatform: flags['strict-platform'] || null });
  console.log(flags.json ? formatJsonSummary(result) : formatMarkdownSummary(result));
}

function printHelp() {
  console.log(`Research benchmark (shared quality pipeline)

Existing-result inspection, offline by default:
  npm run benchmark -- <work-dir> [--json] [--strict-platform <id>]
  npm run benchmark -- --research-id <id> [--json]
  npm run benchmark -- --compare <id1,id2> [--json]
  --no-llm remains a compatibility alias; inspection never invokes a model.

Quality subcommands (identical to benchmark:quality):
  ${QUALITY_COMMANDS.join(', ')}
  npm run benchmark -- score --mode model-observation --program-verification <file> --campaign <file> --gold-dir <dir>
  npm run benchmark -- compare --baseline <campaign> --candidate <campaign>

Inspection verifies declared versioned evidence and reports observable counts.
Missing legacy evidence stays incomplete. Stored verdicts and keyword overlap
are not quality scores. Model scoring requires explicit score inputs.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
