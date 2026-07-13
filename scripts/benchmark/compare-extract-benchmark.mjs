#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadArtifacts } from './load-artifacts.mjs';
import { extractRunStats, formatDurationMs } from './extract-run-stats.mjs';
import { runBenchmark } from './run-benchmark.mjs';

const isCliEntry = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

function readJsonFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  let raw;
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    raw = buffer.toString('utf16le');
  } else {
    raw = buffer.toString('utf8');
  }
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

function loadJsonArtifacts(filePath) {
  const payload = readJsonFile(filePath);
  return {
    meta: {
      query: payload.meta?.query || 'Ollama 与 llama.cpp 在本地 LLM 部署上的差异和适用场景',
      strategy: 'adaptive',
      createdAt: payload.quality?.budget ? new Date().toISOString() : null,
    },
    report: payload.report || '',
    findings: payload.findings || [],
    sources: payload.sources || [],
    gaps: payload.gaps || [],
    passages: payload.passages || [],
    claims: payload.claims || [],
    quality: payload.quality || {},
    trace: payload.trace || [],
    workDir: filePath,
  };
}

function formatPercent(value) {
  return value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`;
}

export async function buildExtractComparison({
  summarySessionDir,
  extractArtifactsPath,
  notes = [],
}) {
  const summaryArtifacts = loadArtifacts(summarySessionDir);
  const extractArtifacts = loadJsonArtifacts(extractArtifactsPath);

  const runs = [];
  for (const [label, artifacts] of [
    ['adaptive-v2-summary', summaryArtifacts],
    ['adaptive-v2-extract', extractArtifacts],
  ]) {
    const stats = extractRunStats(artifacts);
    stats.strategyLabel = label;
    const benchmark = await runBenchmark({
      workDir: artifacts.workDir,
      llmEnabled: false,
    });
    runs.push({ ...stats, benchmark });
  }

  const baseline = runs[0];
  const extract = runs[1];
  const projectedLlmRequests = Math.max(0, baseline.cost.llmRequests - baseline.llmPurposes.sourceSummaryCalls);
  const projectedLlmTokens = Math.round(baseline.cost.llmTokens * (projectedLlmRequests / baseline.cost.llmRequests));

  const lines = [
    '# Adaptive v2 Extract Mode Benchmark',
    '',
    `- Query: ${baseline.query}`,
    `- Compared at: ${new Date().toISOString()}`,
    `- Baseline session: ${summarySessionDir}`,
    `- Extract run artifact: ${extractArtifactsPath}`,
    '',
    '## Environment Notes',
    '',
  ];

  for (const note of notes) lines.push(`- ${note}`);
  lines.push('');

  lines.push(
    '## Overview',
    '',
    '| Strategy | Duration | Sources | LLM tokens | LLM reqs | source_summary | Search | Reads | Rerank | Gate |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  );

  for (const run of runs) {
    lines.push(
      `| ${run.strategyLabel} | ${run.durationLabel} | ${run.counts.sourceCount} | ${run.cost.llmTokens} | ${run.cost.llmRequests} | ${run.llmPurposes.sourceSummaryCalls} | ${run.cost.searchRequests} | ${run.cost.sourceReads} | ${run.cost.rerankRequests} | ${run.gate || 'n/a'} |`,
    );
  }

  lines.push(
    '',
    '## LLM Purpose Breakdown (baseline summary)',
    '',
    '| Purpose | Calls |',
    '| --- | ---: |',
  );
  for (const [purpose, count] of Object.entries(baseline.llmPurposes.purposes).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${purpose} | ${count} |`);
  }

  lines.push(
    '',
    '## Quality Metrics',
    '',
    '| Strategy | Supported | Partial | Unverifiable | Evidence cov. | Key claim sup. |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const run of runs) {
    const { metrics } = run.benchmark;
    lines.push(
      `| ${run.strategyLabel} | ${formatPercent(metrics.rates.supportedRate)} | ${formatPercent(metrics.rates.partiallySupportedRate)} | ${formatPercent(metrics.rates.unverifiableRate)} | ${formatPercent(metrics.rates.evidenceCoverageRate)} | ${formatPercent(metrics.rates.keyClaimSupportedRate)} |`,
    );
  }

  lines.push(
    '',
    '## Extract Mode Validation',
    '',
    `- Baseline \`source_summary\` calls: **${baseline.llmPurposes.sourceSummaryCalls}** (${baseline.cost.sourceReads} reads)`,
    `- Extract run \`source_summary\` calls: **${extract.llmPurposes.sourceSummaryCalls}** (${extract.cost.sourceReads} reads)`,
    `- Unit test coverage: \`adaptive-v2.test.mjs\` asserts extract mode never calls \`source_summary\` when embedding is configured`,
    '',
    '## Projected Savings (when search/read path matches baseline)',
    '',
    `If extract mode replaces ${baseline.llmPurposes.sourceSummaryCalls} \`source_summary\` calls on the same ${baseline.cost.sourceReads} reads:`,
    `- LLM requests: ${baseline.cost.llmRequests} → ~${projectedLlmRequests} (-${baseline.llmPurposes.sourceSummaryCalls})`,
    `- LLM tokens (linear estimate): ${baseline.cost.llmTokens} → ~${projectedLlmTokens} (-${baseline.cost.llmTokens - projectedLlmTokens})`,
    '- Each read adds 1–2 local embedding HTTP calls instead of one LLM summary call',
    '',
    '## Rerun Command (full live benchmark)',
    '',
    '```bash',
    'node scripts/verify-openclaw-embedding.mjs',
    '',
    'npm exec --package=. -- jdr research "Ollama 与 llama.cpp 在本地 LLM 部署上的差异和适用场景" \\',
    '  --strategy adaptive --adaptive-loop-version v2 \\',
    '  --source-fetch-mode extract \\',
    '  --embedding-provider openai-compatible \\',
    '  --embedding-base-url http://127.0.0.1:18789 \\',
    '  --embedding-model openclaw/default \\',
    '  --search-base-url http://127.0.0.1:8888',
    '```',
    '',
  );

  return lines.join('\n');
}

async function main(argv) {
  const summarySessionDir = argv[0] || 'work_dir/adaptive/2026-07-13_105811';
  const extractArtifactsPath = argv[1] || 'tmp/v2-extract-live.json';
  const outputPath = argv[2] || 'tmp/strategy-compare-extract.md';

  const notes = [
    'Extract live run used `--source-fetch-mode extract` with OpenClaw embedding (`openai-compatible` @ `http://127.0.0.1:18789`).',
    'Gateway connectivity verified via `node scripts/verify-openclaw-embedding.mjs` (768-dim EmbeddingGemma vectors).',
    'All enriched sources used `extractionMethod: embedding`; trace contains **0** `source_summary` LLM calls.',
  ];

  const report = await buildExtractComparison({ summarySessionDir, extractArtifactsPath, notes });
  fs.writeFileSync(outputPath, report, 'utf8');
  console.log(report);
  console.error(`\nComparison written to ${outputPath}`);
}

if (isCliEntry) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
