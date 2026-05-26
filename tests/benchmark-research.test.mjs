import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { buildCitationMap, parseCitations, resolveCitations } from '../scripts/benchmark/citations.mjs';
import { extractClaims } from '../scripts/benchmark/claims.mjs';
import { loadArtifacts } from '../scripts/benchmark/load-artifacts.mjs';
import { scoreClaimRule, summarizeFindingsHealth } from '../scripts/benchmark/rule-score.mjs';
import { runBenchmark } from '../scripts/benchmark/run-benchmark.mjs';
import { formatJsonSummary } from '../scripts/benchmark/format-output.mjs';

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function createFixture({
  report,
  findings,
  sources,
  meta = {
    query: 'llm wiki',
    strategy: 'source-based',
    researchId: 'test-id',
  },
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-'));
  tempDirs.push(dir);

  fs.writeFileSync(path.join(dir, 'report.md'), report, 'utf8');
  fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(findings, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify(sources, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  return dir;
}

describe('benchmark citations', () => {
  it('maps findings sources to citation keys', () => {
    const map = buildCitationMap([
      {
        question: 'q1',
        sources: [{ title: 'A', url: 'https://a', snippet: 'alpha', engine: 'js-eyes:zhihu' }],
      },
      {
        question: 'q2',
        sources: [
          { title: 'B1', url: 'https://b1', snippet: 'beta', engine: 'js-eyes:zhihu' },
          { title: 'B2', url: 'https://b2', snippet: 'gamma', engine: 'js-eyes:zhihu' },
        ],
      },
    ]);

    assert.equal(map.get('1.1')?.source.title, 'A');
    assert.equal(map.get('2.3'), undefined);
    assert.equal(map.get('2.2')?.source.title, 'B2');
  });

  it('parses and resolves citation markers from claim text', () => {
    const map = buildCitationMap([
      {
        question: 'q1',
        sources: [{ title: 'A', url: 'https://a', snippet: 'alpha', engine: 'js-eyes:zhihu' }],
      },
    ]);

    const keys = parseCitations('Claim text [1.1][9.9] and again [1.1].');
    assert.deepEqual(keys, ['1.1', '9.9']);

    const resolved = resolveCitations(keys, map);
    assert.deepEqual(resolved.unresolved, ['9.9']);
    assert.equal(resolved.resolved.length, 1);
  });
});

describe('benchmark claims', () => {
  it('extracts claims from Summary, Key Findings, and Evidence', () => {
    const claims = extractClaims(`# Report

## Summary

This is a summary claim without citation.

## Key Findings

1. **Finding one**: details [1.1].

## Evidence

- Evidence item [1.1].
`);

    assert.equal(claims.length, 3);
    assert.equal(claims[0].section, 'Summary');
    assert.match(claims[1].text, /Finding one/);
    assert.match(claims[2].text, /Evidence item/);
  });
});

describe('benchmark rule scoring', () => {
  it('flags empty sources and failed findings', () => {
    const health = summarizeFindingsHealth(
      [{ question: 'q1', error: { message: 'failed' } }],
      [],
    );

    assert.deepEqual(health.flags.sort(), ['all_findings_failed', 'empty_sources', 'no_finding_sources']);
  });

  it('flags missing citations and platform mismatch', () => {
    const map = buildCitationMap([
      {
        question: 'q1',
        sources: [{ title: 'Reddit post', url: 'https://r', snippet: 'reddit', engine: 'js-eyes:reddit' }],
      },
    ]);

    const noCitation = scoreClaimRule(
      { section: 'Summary', text: 'No citation here.' },
      map,
    );
    assert.ok(noCitation.flags.includes('no_citation'));

    const platformMismatch = scoreClaimRule(
      { section: 'Evidence', text: 'Claim [1.1].' },
      map,
      { strictPlatform: 'js-eyes:zhihu' },
    );
    assert.ok(platformMismatch.flags.includes('platform_mismatch'));
  });

  it('scores keyword overlap using summary and content evidence', () => {
    const map = buildCitationMap([
      {
        question: 'q1',
        sources: [{
          title: 'Wiki',
          url: 'https://a',
          snippet: 'short title only',
          summary: 'Karpathy LLM Wiki compiler-style RAG workflow',
          engine: 'js-eyes:zhihu',
        }],
      },
    ]);

    const scored = scoreClaimRule(
      { section: 'Summary', text: 'Karpathy LLM Wiki uses compiler-style RAG [1.1].' },
      map,
    );

    assert.ok(scored.keywordOverlap > 0.2);
    assert.equal(scored.flags.includes('low_keyword_overlap'), false);
  });
});

describe('runBenchmark', () => {
  it('runs offline with --no-llm semantics', async () => {
    const dir = createFixture({
      report: `# Report

## Summary

Karpathy LLM Wiki uses compiler-style RAG [1.1].

## Key Findings

1. **Obsidian workflow**: users build personal wikis [1.1].
`,
      findings: [
        {
          question: 'llm wiki',
          sources: [{
            title: '用Obsidian打造LLM-Wiki经验分享',
            url: 'https://zhuanlan.zhihu.com/p/1',
            snippet: '用Obsidian打造LLM-Wiki经验分享',
            engine: 'js-eyes:zhihu',
          }],
        },
      ],
      sources: [{
        title: '用Obsidian打造LLM-Wiki经验分享',
        url: 'https://zhuanlan.zhihu.com/p/1',
        snippet: '用Obsidian打造LLM-Wiki经验分享',
        engine: 'js-eyes:zhihu',
      }],
    });

    const result = await runBenchmark({
      workDir: dir,
      strictPlatform: 'js-eyes:zhihu',
      llmEnabled: false,
    });

    assert.equal(result.metrics.claimCount, 2);
    assert.equal(result.llmEnabled, false);
    assert.equal(result.metrics.claimsWithCitationsRate, 1);
    assert.equal(result.metrics.citationResolutionRate, 1);
    assert.equal(result.metrics.platformMatchRate, 1);
    assert.equal(result.artifactsHealth.sourceCount, 1);

    const json = JSON.parse(formatJsonSummary(result));
    assert.equal(json.claims.length, 2);
    assert.equal(json.claims[0].llm.skipped, true);
  });

  it('marks unresolved citations and empty-source artifacts as risky', async () => {
    const dir = createFixture({
      report: `# Report

## Evidence

- Unsupported claim [9.9].
`,
      findings: [{ question: 'q1', sources: [] }],
      sources: [],
    });

    const result = await runBenchmark({
      workDir: dir,
      llmEnabled: false,
    });

    assert.ok(result.artifactsHealth.flags.includes('empty_sources'));
    assert.ok(result.riskExamples.some((entry) => entry.flags.includes('citation_unresolved')));
  });

  it('loads artifacts from disk', () => {
    const dir = createFixture({
      report: '# Report\n\n## Summary\n\nText.',
      findings: [],
      sources: [],
    });

    const artifacts = loadArtifacts(dir);
    assert.equal(artifacts.meta.query, 'llm wiki');
    assert.match(artifacts.report, /Summary/);
  });
});
