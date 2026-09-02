import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateGapEvidence,
  buildEvidenceArtifacts,
  GAP_SCHEMA_VERSION,
  RESEARCH_BRIEF_SCHEMA_VERSION,
  sanitizeResearchBrief,
  researchBriefFromInput,
  mergeResearchBrief,
  resolveReadSettings,
  ResearchRunner,
} from '../src/index.mjs';
import { runFocusedPipeline } from '../src/research/strategies/focused-pipeline.mjs';
import { runQuick } from '../src/research/strategies/quick.mjs';
import { QueryMemory } from '../src/research/query-memory.mjs';
import { renderSourcesSection } from '../src/research/report-assembler.mjs';
import { buildStrategyContext } from '../src/research/strategy-context.mjs';
import { rollupRootGap } from '../src/research/gap-state.mjs';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';
import { applyContractGaps } from '../src/research/research-contract.mjs';
import { defaultSearchQueryPlan } from './helpers/search-query-planner-mock.mjs';

const BODY_QUOTE = 'A sufficiently detailed fetched source body containing direct evidence for this alpha and beta answer slot.';

function body(url, extra = {}) {
  return {
    title: url,
    url,
    content: BODY_QUOTE,
    fetchStatus: 'ok',
    ...extra,
  };
}

function gapSupportResponse(messages, { supported = true } = {}) {
  const text = (messages || []).map((item) => item.content).join('\n');
  const gapIds = [...new Set([...text.matchAll(/gapId:\s+(gap-\S+)/g)].map((match) => match[1]))];
  const ids = gapIds.length ? gapIds : ['gap-2'];
  return JSON.stringify({
    judgments: ids.map((gapId) => ({
      gapId,
      verdict: supported && text.includes(BODY_QUOTE) ? 'supported' : 'unsupported',
      quote: BODY_QUOTE,
      reason: 'test slot support',
    })),
  });
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
  it('materializes every required slot despite duplicate planner questions and the default gap cap', () => {
    const requiredAnswerSlots = Array.from({ length: 10 }, (_, index) => ({
      id: `apple-slot-${index + 1}`,
      answerSlot: index === 9 ? 'Ollama compatibility' : `Apple slot ${index + 1}`,
      question: 'Compare Apple local inference options',
      priority: 'normal',
    }));
    const brief = sanitizeResearchBrief({
      query: 'Compare Apple local inference options',
      requiredAnswerSlots,
    }, { allowExplicitHosts: true });
    const state = new ResearchState({ query: brief.query, brief });
    applyContractGaps(state, { brief, profile: state.profile, slots: brief.requiredAnswerSlots }, { maxGaps: 8 });
    const slotGaps = state.gaps.filter((gap) => gap.requiredSlot);
    assert.equal(slotGaps.length, 10);
    assert.equal(new Set(slotGaps.map((gap) => gap.contractSlotId)).size, 10);
    assert.ok(slotGaps.some((gap) => gap.answerSlot === 'Ollama compatibility'));
  });

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

    const userBrief = researchBriefFromInput({
      query: 'Read docs.example.com for product status',
      requiredAnswerSlots: [{
        answerSlot: 'status',
        requiredHosts: ['docs.example.com', 'sec.gov', 'not a host'],
      }],
    });
    assert.deepEqual(userBrief.requiredAnswerSlots[0].requiredHosts, ['docs.example.com', 'sec.gov']);
  });

  it('keeps user structured values ahead of planner fills', () => {
    const merged = mergeResearchBrief({
      query: 'Read docs.example.com for product status',
      exclusions: ['forums'],
      successCriteria: ['cite official docs'],
      requiredAnswerSlots: [{
        answerSlot: 'status',
        question: 'What is supported?',
        requiredHosts: ['sec.gov'],
      }],
    }, {
      exclusions: ['planner-only'],
      successCriteria: ['planner metric'],
      requiredAnswerSlots: [{
        answerSlot: 'planner slot',
        requiredHosts: ['hkexnews.hk', 'docs.example.com'],
      }],
    });
    assert.deepEqual(merged.exclusions, ['forums']);
    assert.deepEqual(merged.successCriteria, ['cite official docs']);
    assert.equal(merged.requiredAnswerSlots[0].answerSlot, 'status');
    assert.deepEqual(merged.requiredAnswerSlots[0].requiredHosts, ['sec.gov']);

    const plannerFill = mergeResearchBrief({
      query: 'Read docs.example.com for product status',
    }, {
      requiredAnswerSlots: [{
        answerSlot: 'docs',
        requiredHosts: ['docs.example.com', 'sec.gov'],
      }],
    });
    assert.deepEqual(plannerFill.requiredAnswerSlots[0].requiredHosts, ['docs.example.com']);
  });

  it('passes structured brief through strategy context to focused', async () => {
    const brief = researchBriefFromInput({
      query: 'compare alpha and beta',
      exclusions: ['reddit'],
      requiredAnswerSlots: [
        { answerSlot: 'alpha', question: 'alpha evidence', priority: 'normal' },
        { answerSlot: 'beta', question: 'beta evidence', priority: 'critical' },
      ],
    });
    const built = buildStrategyContext({
      query: brief.query,
      brief,
      settings: { research: { iterations: 1, questionsPerIteration: 2 } },
      llm: { async complete() { return '[]'; } },
      search: { async search() { return []; } },
      emit() {},
    });
    assert.equal(built.brief.exclusions[0], 'reddit');
    assert.equal(built.brief.requiredAnswerSlots.length, 2);

    const runner = new ResearchRunner();
    const result = await runner.run({
      query: {
        query: 'compare alpha and beta',
        exclusions: ['reddit'],
        requiredAnswerSlots: [
          { answerSlot: 'alpha', question: 'alpha evidence', priority: 'normal' },
        ],
      },
      settings: {
        llm: {},
        search: {},
        research: {
          strategy: 'focused',
          iterations: 1,
          questionsPerIteration: 1,
          focused: {
            fetchMode: 'disabled',
            challenge: { enabled: false },
            iterationControl: { enabled: false },
            sourceSelection: { enabled: false },
          },
        },
      },
      search: { async search() { return [{ title: 'S', url: 'https://example.com/a', snippet: 's' }]; } },
      llm: {
        async complete({ purpose, messages }) {
          if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
          if (purpose === 'research_profile') {
            return JSON.stringify({
              exclusions: ['planner'],
              requiredAnswerSlots: [{ answerSlot: 'planner', question: 'planner' }],
            });
          }
          return '# Research Report\n\n## Summary\n\nStructured brief survived planner merge and remains user-authored rather than overwritten. [1.1]\n\n## Key Findings\n\nThe user exclusions and required answer slots stayed intact after sanitization.\n\n## Caveats\n\nThe test evidence is intentionally limited and should not be treated as complete.';
        },
      },
    });
    assert.deepEqual(result.brief.exclusions, ['reddit']);
    assert.equal(result.brief.requiredAnswerSlots[0].answerSlot, 'alpha');
    assert.ok(result.trace.some((entry) => entry.action === 'research_brief' && entry.reasonCode === 'structured_input'));
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
    assert.ok(!conflicting.supportingPassageIds.some((id) => conflicting.contradictingPassageIds.includes(id)));
    const withPassages = evaluateGapEvidence(base, [
      body('https://filings.example.com/r', { id: 'src-a', passageIds: ['p-support'] }),
      body('https://filings.example.com/correction', { id: 'src-b', evidenceRole: 'contradicting', passageIds: ['p-contra'] }),
    ]);
    assert.deepEqual(withPassages.supportingPassageIds, ['p-support']);
    assert.deepEqual(withPassages.contradictingPassageIds, ['p-contra']);
  });

  it('treats a normal required slot as material and rolls root status up', () => {
    const gaps = rollupRootGap([
      {
        id: 'gap-1',
        kind: 'root',
        rollup: true,
        requiredSlot: false,
        priority: 'critical',
        status: 'open',
        question: 'root',
      },
      {
        id: 'gap-2',
        kind: 'slot',
        requiredSlot: true,
        priority: 'normal',
        status: 'limited',
        question: 'normal required',
        missingEvidence: ['independent_sources'],
      },
    ]);
    assert.equal(gaps[0].status, 'limited');
    assert.match(gaps[0].resolutionReason, /incomplete body evidence/);
  });

  it('runs a repair wave only for material gaps left open by discovery', async () => {
    const calls = [];
    const ctx = context({
      llm: {
        async complete({ purpose, messages }) {
          if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
          if (purpose === 'research_profile') {
            return JSON.stringify({
              minIndependentSources: 1,
              requiredAnswerSlots: [
                { answerSlot: 'alpha', question: 'alpha evidence', priority: 'normal' },
                { answerSlot: 'beta', question: 'beta evidence', priority: 'critical' },
              ],
            });
          }
          if (purpose === 'gap_support') return gapSupportResponse(messages);
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
    assert.ok(calls.some((query) => query.includes('beta evidence')));
    assert.ok(!calls.some((query) => /primary source evidence|successful_body/.test(query)));
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
        async complete({ purpose, messages }) {
          if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
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
        async complete({ purpose }) {
          if (purpose === 'search_query_planning') {
            return JSON.stringify({
              queries: [
                { query: 'alpha deployment guide details' },
                { query: 'alpha deployment guide' },
              ],
            });
          }
          return JSON.stringify({ queries: [] });
        },
      },
    });
    assert.equal(calls, 1);
    assert.equal(findings.length, 1);
    assert.equal(memory.snapshot().length, 1);
  });

  it('batches and caches semantic query dedup without suppressing another contract slot', async () => {
    const calls = [];
    const embedding = {
      async embedDocuments(texts) {
        calls.push([...texts]);
        return texts.map((text) => {
          const normalized = text.toLowerCase();
          if (normalized.includes('ollama')) return [0, 1];
          if (normalized.includes('performance')) return [0.7, 0.7];
          return [1, 0];
        });
      },
    };
    const memory = new QueryMemory({ enabled: true });
    const first = await memory.filterDuplicates(['MLX official support', 'MLX performance evidence'], {
      gapId: 'slot-mlx',
      embedding,
    });
    assert.equal(first.accepted.length, 2);
    memory.record({ query: first.accepted[0], gapId: 'slot-mlx', status: 'useful' });
    const repeated = await memory.filterDuplicates(['MLX official support'], {
      gapId: 'slot-mlx',
      embedding,
    });
    assert.equal(repeated.accepted.length, 0);
    const otherSlot = await memory.filterDuplicates(['Ollama official support'], {
      gapId: 'slot-ollama',
      embedding,
    });
    assert.deepEqual(otherSlot.accepted, ['ollama official support']);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].length, 2);
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

  it('repairs a normal required slot and does not search the roll-up root', async () => {
    const calls = [];
    const ctx = context({
      brief: researchBriefFromInput({
        query: 'compare alpha and beta',
        requiredAnswerSlots: [
          { answerSlot: 'alpha', question: 'alpha evidence', priority: 'normal' },
          { answerSlot: 'beta', question: 'beta evidence', priority: 'normal' },
        ],
      }),
      llm: {
        async complete({ purpose, messages }) {
          if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
          if (purpose === 'gap_support') return gapSupportResponse(messages);
          return '{}';
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
    const root = findings.researchControl.gaps.find((gap) => gap.kind === 'root');
    assert.equal(root.rollup, true);
    assert.ok(!calls.some((query) => query === 'compare alpha and beta' || query.startsWith('compare alpha and beta ')));
    const repair = ctx.trace.find((entry) => entry.action === 'search_wave_started' && entry.wave === 'repair');
    assert.deepEqual(repair.targetGapIds, [
      findings.researchControl.gaps.find((gap) => gap.answerSlot === 'beta').id,
    ]);
    assert.ok(!findings.researchControl.readiness.pass);
    assert.ok(findings.researchControl.readiness.failures.some((failure) => failure.code === 'required_slot_open'));
  });

  it('challenges only exact consequential identities and records a failed spot-check', async () => {
    const ctx = context({
      brief: sanitizeResearchBrief({
        query: 'compare alpha and beta',
        depth: 'focused',
        consequentialClaims: ['alpha safety'],
      }, { allowExplicitHosts: true }),
      settings: {
        research: {
          focused: {
            fetchMode: 'disabled',
            challenge: { enabled: true, maxClaims: 2 },
            sourceSelection: { enabled: false },
            iterationControl: { enabled: false },
          },
        },
      },
      llm: {
        async complete({ purpose, messages }) {
          if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
          if (purpose === 'research_profile') {
            return JSON.stringify({
              minIndependentSources: 1,
              requiredAnswerSlots: [
                { answerSlot: 'alpha safety', question: 'alpha safety', priority: 'critical' },
                { answerSlot: 'unrelated critical', question: 'unrelated critical', priority: 'critical' },
              ],
            });
          }
          return '[]';
        },
      },
      search: {
        id: 'test',
        async search(query) {
          const seen = this._seen || (this._seen = new Set());
          if (seen.has(query) || /limitations and criticism|follow-up research/.test(query)) {
            return [{ title: query, url: `https://example.com/${encodeURIComponent(query)}`, snippet: 'no body' }];
          }
          seen.add(query);
          return [body(`https://example.com/${encodeURIComponent(query)}`)];
        },
      },
    });
    await runFocusedPipeline(ctx);
    const challenge = ctx.trace.find((entry) => entry.action === 'challenge_completed');
    assert.equal(challenge.queryCount, 1);
    assert.deepEqual(challenge.targetGapIds.length, 1);
    const spot = ctx.trace.find((entry) => entry.action === 'claim_spot_check');
    assert.equal(spot.passed, false);
    assert.equal(spot.reasonCode, 'direct_source_missing');
  });

  it('stops extra repair waves once the plateau threshold is reached', async () => {
    const calls = [];
    const ctx = context({
      iterations: 5,
      brief: researchBriefFromInput({
        query: 'compare alpha and beta',
        requiredAnswerSlots: [{ answerSlot: 'alpha', question: 'alpha evidence', priority: 'critical' }],
      }),
      settings: {
        research: {
          focused: {
            fetchMode: 'disabled',
            challenge: { enabled: false },
            sourceSelection: { enabled: false },
            plateau: { enabled: true, maxLowYieldWaves: 1 },
            iterationControl: { enabled: true, minIterations: 1, maxIterations: 5, earlyStop: true },
          },
        },
      },
      llm: { async complete({ purpose, messages }) {
        if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
        return '{}';
      } },
      search: {
        async search(query) {
          calls.push(query);
          return [{ title: query, url: `https://example.com/${calls.length}`, snippet: 'snippet only' }];
        },
      },
    });
    await runFocusedPipeline(ctx);
    const repairs = ctx.trace.filter((entry) => entry.action === 'search_wave_started' && entry.wave === 'repair');
    assert.equal(repairs.length, 1);
    assert.ok(ctx.trace.some((entry) => entry.action === 'focused_stop_decision' && entry.reasonCode !== 'evidence_sufficient'));
  });

  it('honors iterations, early-stop, continueOnCriticalGaps, and shared read settings', async () => {
    const twoWave = context({
      iterations: 2,
      questionCount: 1,
      brief: researchBriefFromInput({
        query: 'compare alpha and beta',
        requiredAnswerSlots: [
          { answerSlot: 'alpha', question: 'alpha evidence', priority: 'normal' },
          { answerSlot: 'beta', question: 'beta evidence', priority: 'normal' },
        ],
      }),
      settings: {
        research: {
          focused: {
            fetchMode: 'disabled',
            challenge: { enabled: false },
            sourceSelection: { enabled: false },
            iterationControl: { enabled: false },
            plateau: { enabled: false },
          },
        },
      },
      llm: { async complete({ purpose, messages }) {
        if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
        return '{}';
      } },
      search: {
        async search(query) {
          return [{ title: query, url: `https://example.com/${encodeURIComponent(query)}`, snippet: 's' }];
        },
      },
    });
    const twoWaveFindings = await runFocusedPipeline(twoWave);
    assert.ok(twoWaveFindings.some((finding) => finding.wave === 'discovery'));
    assert.ok(twoWaveFindings.some((finding) => finding.wave === 'repair'));

    const early = context({
      iterations: 3,
      brief: researchBriefFromInput({
        query: 'compare alpha and beta',
        requiredAnswerSlots: [{ answerSlot: 'alpha', question: 'alpha evidence', priority: 'critical' }],
      }),
      settings: {
        research: {
          focused: {
            fetchMode: 'disabled',
            challenge: { enabled: false },
            sourceSelection: { enabled: false },
            iterationControl: { enabled: true, minIterations: 1, maxIterations: 3, earlyStop: true },
          },
        },
      },
      llm: {
        async complete({ purpose, messages }) {
          if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
          if (purpose === 'gap_support') return gapSupportResponse(messages);
          return '{}';
        },
      },
      search: { async search() { return [body('https://alpha.example.com/ok')]; } },
    });
    await runFocusedPipeline(early);
    assert.equal(early.trace.filter((entry) => entry.action === 'search_wave_started' && entry.wave === 'repair').length, 0);
    assert.equal(early.trace.find((entry) => entry.action === 'focused_stop_decision').reasonCode, 'evidence_sufficient');

    const noContinue = context({
      iterations: 3,
      questionCount: 1,
      brief: researchBriefFromInput({
        query: 'compare alpha and beta',
        requiredAnswerSlots: [{ answerSlot: 'alpha', question: 'alpha evidence', priority: 'critical' }],
      }),
      settings: {
        research: {
          focused: {
            fetchMode: 'disabled',
            challenge: { enabled: false },
            sourceSelection: { enabled: false },
            plateau: { enabled: false },
            iterationControl: {
              enabled: true,
              minIterations: 1,
              maxIterations: 3,
              earlyStop: true,
              continueOnCriticalGaps: false,
            },
          },
        },
      },
      llm: { async complete({ purpose, messages }) {
        if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
        return '{}';
      } },
      search: {
        async search(query) {
          return [{ title: query, url: `https://example.com/${encodeURIComponent(query)}`, snippet: 's' }];
        },
      },
    });
    await runFocusedPipeline(noContinue);
    assert.equal(noContinue.trace.filter((entry) => entry.action === 'search_wave_started' && entry.wave === 'repair').length, 0);

    const shared = resolveReadSettings({
      research: {
        focused: { fetchMode: 'disabled', maxContentChars: 111 },
        read: { fetchMode: 'full', maxContentChars: 4321 },
      },
    }, { strategy: 'focused' });
    assert.equal(shared.fetchMode, 'full');
    assert.equal(shared.maxContentChars, 4321);
  });

  it('respects search-engine concurrency and isolates ordinary search failures', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const ctx = context({
      concurrency: 4,
      brief: researchBriefFromInput({
        query: 'compare alpha and beta',
        requiredAnswerSlots: [
          { answerSlot: 'alpha', question: 'alpha evidence', priority: 'normal' },
          { answerSlot: 'beta', question: 'beta evidence', priority: 'normal' },
        ],
      }),
      settings: {
        research: {
          focused: {
            fetchMode: 'disabled',
            challenge: { enabled: false },
            sourceSelection: { enabled: false },
            iterationControl: { enabled: false },
          },
        },
      },
      llm: { async complete({ purpose, messages }) {
        if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
        return '{}';
      } },
      search: {
        capabilities: { maxQuestionConcurrency: 1 },
        async search(query) {
          inflight += 1;
          maxInflight = Math.max(maxInflight, inflight);
          await new Promise((resolve) => { setTimeout(resolve, 15); });
          inflight -= 1;
          if (query.startsWith('beta evidence')) throw new Error('beta search failed');
          return [body(`https://example.com/${encodeURIComponent(query)}`)];
        },
      },
    });
    const findings = await runFocusedPipeline(ctx);
    assert.equal(maxInflight, 1);
    assert.ok(findings.some((finding) => finding.error?.message === 'beta search failed'));
    assert.ok(findings.some((finding) => !finding.error && finding.sources.length > 0));
  });

  it('propagates AbortError from a focused search wave', async () => {
    const ctx = context({
      brief: researchBriefFromInput({
        query: 'compare alpha and beta',
        requiredAnswerSlots: [{ answerSlot: 'alpha', question: 'alpha evidence' }],
      }),
      llm: { async complete({ purpose, messages }) {
        if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
        return '{}';
      } },
      search: {
        async search() {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        },
      },
    });
    await assert.rejects(() => runFocusedPipeline(ctx), { name: 'AbortError' });
  });

  it('counts exploratory novelty per query and records duplicate queries', async () => {
    const decisions = [
      {
        action: 'search',
        query: 'exploratory novelty topic',
        queries: ['exploratory novelty topic', 'exploratory novelty repeat-url one', 'exploratory novelty repeat-url two'],
        gapId: 'gap-1',
        reasonCode: 'search',
      },
      { action: 'read', sourceIds: ['https://unique.example.com/exploratory%20novelty%20topic'], gapId: 'gap-1', reasonCode: 'read' },
      { action: 'answer', reasonCode: 'done' },
    ];
    const result = await new ResearchRunner().run({
      query: 'exploratory novelty topic',
      settings: {
        llm: {},
        search: {},
        research: {
          strategy: 'exploratory',
          exploratory: {
            minLlmTokens: 0,
            maxLlmTokens: 0,
            maxSteps: 8,
            maxEvaluationRetries: 0,
            autoReadTopK: 0,
            maxQueriesPerStep: 3,
          },
          focused: { fetchMode: 'disabled' },
        },
      },
      search: {
        async search(query) {
          if (query.includes('repeat-url')) {
            return [{
              title: 'same',
              url: 'https://shared.example.com/item',
              snippet: 's',
              content: 'A successful exploratory body for novelty accounting.',
              fetchStatus: 'ok',
            }];
          }
          return [{
            title: query,
            url: `https://unique.example.com/${encodeURIComponent(query)}`,
            snippet: 's',
            content: 'A successful exploratory body for novelty accounting.',
            fetchStatus: 'ok',
          }];
        },
      },
      llm: {
        async complete({ purpose, messages }) {
          if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
          if (purpose === 'agent_decision') return JSON.stringify(decisions.shift());
          if (purpose === 'research_profile') {
            return JSON.stringify({
              requiredAnswerSlots: [{ answerSlot: 'topic', question: 'topic evidence', priority: 'normal' }],
              minIndependentSources: 1,
            });
          }
          if (purpose === 'gap_support') {
            return JSON.stringify({
              judgments: [{
                verdict: 'supported',
                quote: 'A successful exploratory body for novelty accounting.',
              }],
            });
          }
          return '# Research Report\n\n## Summary\n\nPer-query novelty is recorded without treating a later duplicate as new yield. [1.1]\n\n## Key Findings\n\nThe second query that reused the same URL did not inflate novelty.\n\n## Caveats\n\nThe test evidence is intentionally limited and should not be treated as complete.';
        },
      },
    });
    const marginal = result.quality.metrics.marginal;
    assert.ok(marginal.searchCount >= 2);
    assert.ok(Number.isFinite(marginal.duplicateQueryCount));
    assert.ok(Number.isFinite(marginal.recentNewIndependentSources));
  });

  it('does not close a required slot or root from unrelated long body text', async () => {
    const ctx = context({
      brief: researchBriefFromInput({
        query: 'compare SubjectA and SubjectB',
        requiredAnswerSlots: [{ answerSlot: 'SubjectA', question: 'SubjectA official status', priority: 'critical' }],
      }),
      settings: {
        research: {
          focused: {
            fetchMode: 'disabled',
            challenge: { enabled: false },
            sourceSelection: { enabled: false },
            iterationControl: { enabled: true, minIterations: 1, maxIterations: 3, earlyStop: true },
          },
        },
      },
      llm: {
        async complete({ purpose, messages }) {
          if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
          if (purpose === 'gap_support') {
            return JSON.stringify({
              judgments: [{
                gapId: 'gap-2',
                verdict: 'unsupported',
                quote: 'weather patterns, rainfall totals, and agricultural cycles without mentioning',
              }],
            });
          }
          return '{}';
        },
      },
      search: {
        async search() {
          return [{
            title: 'weather',
            url: 'https://news.example.com/weather',
            content: 'This long article discusses weather patterns, rainfall totals, and agricultural cycles without mentioning SubjectA or SubjectB.',
            fetchStatus: 'ok',
          }];
        },
      },
    });
    const findings = await runFocusedPipeline(ctx);
    const slot = findings.researchControl.gaps.find((gap) => gap.requiredSlot);
    assert.notEqual(slot.status, 'verified');
    assert.equal(findings.researchControl.readiness.pass, false);
    assert.notEqual(ctx.trace.find((entry) => entry.action === 'focused_stop_decision')?.reasonCode, 'evidence_sufficient');
  });

  it('keeps quick isolated from profile, slot judge, and readiness', async () => {
    const purposes = [];
    const findings = await runQuick({
      query: 'SubjectA overview',
      iterations: 1,
      questionCount: 1,
      concurrency: 1,
      emit() {},
      queryMemory: new QueryMemory({ enabled: false }),
      search: {
        async search() {
          return [{ url: 'https://example.com/a', title: 'A', snippet: 'snippet only' }];
        },
      },
      llm: {
        async complete({ purpose }) {
          purposes.push(purpose);
          if (purpose === 'search_query_planning') {
            return JSON.stringify({ queries: [{ query: 'follow-up' }] });
          }
          return JSON.stringify({ queries: [] });
        },
      },
    });
    assert.ok(!purposes.includes('research_profile'));
    assert.ok(!purposes.includes('gap_support'));
    assert.equal(findings.length >= 1, true);
    assert.ok(!findings.researchControl);
  });
});
