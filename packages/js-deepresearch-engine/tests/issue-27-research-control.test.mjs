import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateGapEvidence,
  buildEvidenceArtifacts,
  GAP_SCHEMA_VERSION,
  RESEARCH_BRIEF_SCHEMA_VERSION,
  sanitizeResearchBrief,
} from '../src/index.mjs';
import { runFocusedPipeline } from '../src/research/strategies/focused-pipeline.mjs';
import { runQuick } from '../src/research/strategies/quick.mjs';
import { QueryMemory } from '../src/research/query-memory.mjs';
import { renderSourcesSection } from '../src/research/report-assembler.mjs';

function body(url, extra = {}) {
  return {
    title: url,
    url,
    content: 'A sufficiently detailed fetched source body containing direct evidence for this answer slot.',
    fetchStatus: 'ok',
    ...extra,
  };
}

function context(overrides = {}) {
  const trace = [];
  return {
    query: 'compare alpha and beta',
    brief: sanitizeResearchBrief({ query: 'compare alpha and beta', depth: 'focused' }),
    iterations: 2,
    questionCount: 3,
    concurrency: 2,
    signal: undefined,
    emit() {},
    budget: null,
    queryMemory: new QueryMemory({ enabled: true }),
    trace,
    researchProviders: {},
    settings: {
      research: {
        focused: {
          fetchMode: 'disabled',
          challenge: { enabled: false, maxClaims: 1 },
          sourceSelection: { enabled: false },
        },
      },
    },
    ...overrides,
  };
}

describe('Issue #27 structured research control', () => {
  it('sanitizes and versions ResearchBrief without inventing planner hosts', () => {
    const brief = sanitizeResearchBrief({
      query: 'Read docs.example.com for product status',
      audience: '  Engineering   leaders ',
      depth: 'invalid',
      requiredAnswerSlots: [{
        answerSlot: 'status',
        question: 'What is supported?',
        priority: 'critical',
        requiredHosts: ['docs.example.com', 'sec.gov', 'not a host'],
        requiredSourceTypes: ['numeric', 'exchange'],
      }],
      consequentialClaims: [' production ready ', 'production ready'],
    }, { depth: 'focused' });
    assert.equal(brief.schemaVersion, RESEARCH_BRIEF_SCHEMA_VERSION);
    assert.equal(brief.audience, 'Engineering leaders');
    assert.equal(brief.depth, 'focused');
    assert.deepEqual(brief.requiredAnswerSlots[0].requiredHosts, ['docs.example.com']);
    assert.deepEqual(brief.requiredAnswerSlots[0].requiredSourceTypes, ['numeric']);
    assert.deepEqual(brief.consequentialClaims, ['production ready']);
    assert.doesNotThrow(() => JSON.stringify(brief));
  });

  it('moves claim gaps only with deterministic body and source-policy evidence', () => {
    const base = {
      schemaVersion: GAP_SCHEMA_VERSION,
      id: 'gap-1',
      question: 'revenue',
      answerSlot: 'revenue',
      priority: 'critical',
      status: 'searched',
      minIndependentSources: 1,
      requiredHosts: ['filings.example.com'],
    };
    const snippet = evaluateGapEvidence(base, [{ url: 'https://filings.example.com/r', snippet: '100' }]);
    assert.equal(snippet.status, 'searched');
    assert.ok(snippet.missingEvidence.includes('successful_body'));
    const limited = evaluateGapEvidence(base, [body('https://news.example.com/r')]);
    assert.equal(limited.status, 'limited');
    const verified = evaluateGapEvidence(base, [body('https://filings.example.com/r')], {
      passageIds: ['passage-1'],
    });
    assert.equal(verified.status, 'verified');
    assert.deepEqual(verified.supportingPassageIds, ['passage-1']);
    const conflicting = evaluateGapEvidence(base, [
      body('https://filings.example.com/r'),
      body('https://filings.example.com/correction', { evidenceRole: 'contradicting' }),
    ]);
    assert.equal(conflicting.status, 'conflicting');
  });

  it('runs a repair wave only for material gaps left open by discovery', async () => {
    const calls = [];
    const ctx = context({
      llm: {
        async complete({ purpose }) {
          if (purpose === 'research_profile') {
            return JSON.stringify({
              minIndependentSources: 1,
              requiredAnswerSlots: [
                { answerSlot: 'alpha', question: 'alpha evidence', priority: 'normal' },
                { answerSlot: 'beta', question: 'beta evidence', priority: 'critical' },
              ],
            });
          }
          return '[]';
        },
      },
      search: {
        id: 'test',
        async search(query) {
          calls.push(query);
          if (query.startsWith('beta evidence')) return [];
          return [body(`https://source-${calls.length}.example.com/source`)];
        },
      },
    });
    const findings = await runFocusedPipeline(ctx);
    const repair = ctx.trace.find((entry) => entry.action === 'search_wave_started' && entry.wave === 'repair');
    assert.deepEqual(repair.targetGapIds, [
      findings.researchControl.gaps.find((gap) => gap.answerSlot === 'beta').id,
    ]);
    assert.ok(calls.some((query) => query.startsWith('beta evidence') && query.includes('successful_body')));
    assert.ok(!repair.queries.some((query) => query.startsWith('alpha evidence')));
    assert.ok(ctx.trace.some((entry) => entry.action === 'plateau_evaluated' && entry.plateau));
  });

  it('bounds consequential challenge and records a spot-check', async () => {
    const ctx = context({
      brief: sanitizeResearchBrief({
        query: 'compare alpha and beta',
        depth: 'focused',
        consequentialClaims: ['alpha safety', 'beta safety'],
      }),
      settings: {
        research: {
          focused: {
            fetchMode: 'disabled',
            challenge: { enabled: true, maxClaims: 1 },
            sourceSelection: { enabled: false },
          },
        },
      },
      llm: {
        async complete({ purpose }) {
          if (purpose === 'research_profile') {
            return JSON.stringify({
              minIndependentSources: 1,
              requiredAnswerSlots: [
                { answerSlot: 'alpha safety', question: 'alpha safety', priority: 'critical' },
                { answerSlot: 'beta safety', question: 'beta safety', priority: 'critical' },
              ],
              consequentialClaims: ['alpha safety', 'beta safety'],
            });
          }
          return '[]';
        },
      },
      search: {
        id: 'test',
        async search(query) {
          return [body(`https://example.com/${encodeURIComponent(query)}`)];
        },
      },
    });
    await runFocusedPipeline(ctx);
    const challenge = ctx.trace.find((entry) => entry.action === 'challenge_completed');
    assert.equal(challenge.queryCount, 1);
    assert.ok(ctx.trace.some((entry) => entry.action === 'claim_spot_check' && entry.passed));
  });

  it('uses QueryMemory to suppress near-duplicate quick queries before concurrent search', async () => {
    let calls = 0;
    const memory = new QueryMemory({ enabled: true, similarityThreshold: 0.7 });
    const findings = await runQuick({
      query: 'alpha deployment guide',
      iterations: 1,
      questionCount: 2,
      concurrency: 3,
      emit() {},
      queryMemory: memory,
      search: {
        async search(query) {
          calls += 1;
          return [{ url: `https://example.com/${calls}`, title: query, snippet: 'result' }];
        },
      },
      llm: {
        async complete() {
          return JSON.stringify(['alpha deployment guide details', 'alpha deployment guide']);
        },
      },
    });
    assert.equal(calls, 1);
    assert.equal(findings.length, 1);
    assert.equal(memory.snapshot().length, 1);
  });

  it('round-trips observed provenance through evidence and report sources', () => {
    const observed = {
      ...body('https://example.com/release'),
      publisher: 'Example Foundation',
      author: 'A. Maintainer',
      publishedAt: '2026-08-01',
      accessedAt: '2026-08-31T12:00:00.000Z',
      sourceType: 'official_documentation',
      accessStatus: 'ok',
    };
    const artifacts = buildEvidenceArtifacts({
      query: 'release',
      findings: [{ question: 'release', sources: [observed] }],
      options: { enabled: true },
    });
    assert.equal(artifacts.sources[0].publisher, 'Example Foundation');
    assert.equal(artifacts.passages[0].provenance.author, 'A. Maintainer');
    const reportSources = renderSourcesSection(artifacts.findings);
    assert.match(reportSources, /publisher: Example Foundation/);
    assert.match(reportSources, /accessed: 2026-08-31/);
  });
});
