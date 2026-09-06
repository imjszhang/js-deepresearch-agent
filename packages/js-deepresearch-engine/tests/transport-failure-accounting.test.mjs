import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ResearchRunner } from '../src/index.mjs';
import {
  registerContentFetchHandler,
  resetContentFetchHandlers,
} from '../src/research/content-resolver.mjs';
import { evaluateEvidenceCriteria, sourceSatisfiesCriterion } from '../src/research/evidence-criteria.mjs';
import { evaluateReadinessGate } from '../src/research/adaptive/readiness-gate.mjs';
import { defaultSearchQueryPlan } from './helpers/search-query-planner-mock.mjs';

afterEach(() => resetContentFetchHandlers());

function report() {
  return '# Research Report\n\n## Summary\n\nThe official pages refused every read attempt, so this run reports what could not be retrieved rather than inventing coverage. [1.1]\n\n## Key Findings\n\nNo first-party body was retrieved because the publisher returned HTTP 403 for every candidate URL. [1.1]';
}

function llmFor(decisions) {
  return {
    async complete({ purpose, messages }) {
      if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
      if (purpose === 'agent_decision') {
        return JSON.stringify(decisions.shift() || { action: 'answer', reasonCode: 'exhausted' });
      }
      if (purpose === 'research_profile') {
        return JSON.stringify({
          requiredAnswerSlots: [{ answerSlot: 'topic', question: 'topic evidence', priority: 'normal' }],
          minIndependentSources: 1,
        });
      }
      if (purpose === 'gap_decomposition') return 'no json here';
      if (purpose === 'gap_support') return JSON.stringify({ judgments: [] });
      return report();
    },
  };
}

describe('transport failure accounting', () => {
  it('does not spend the invalid-step safety valve on hosts that refuse the read', async () => {
    let fetches = 0;
    registerContentFetchHandler(async () => {
      fetches += 1;
      return {
        status: 'failed',
        error: 'HTTP 403',
        errorType: 'http_4xx',
        httpStatus: 403,
        retryable: false,
        fetchAttempts: 1,
        accessStatus: 'failed',
        accessNotes: 'HTTP 403',
      };
    });

    const decisions = [
      { action: 'search', query: 'walled topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'read', sourceIds: ['https://walled-a.test/one'], gapId: 'gap-1', reasonCode: 'read' },
      { action: 'read', sourceIds: ['https://walled-b.test/two'], gapId: 'gap-1', reasonCode: 'read' },
      { action: 'read', sourceIds: ['https://walled-c.test/three'], gapId: 'gap-1', reasonCode: 'read' },
      { action: 'answer', reasonCode: 'nothing_readable' },
    ];

    const result = await new ResearchRunner().run({
      query: 'walled topic',
      settings: {
        llm: {},
        search: {},
        research: {
          strategy: 'exploratory',
          exploratory: {
            // High floor so the run is far from having spent its exploration budget.
            minLlmTokens: 500000,
            maxLlmTokens: 800000,
            maxSteps: 12,
            maxEvaluationRetries: 0,
            autoReadTopK: 0,
            maxConsecutiveInvalidSteps: 2,
          },
          focused: { fetchMode: 'full', fetchBackend: 'auto' },
        },
      },
      search: {
        async search() {
          return [
            { title: 'One', url: 'https://walled-a.test/one', snippet: 'walled topic snippet one' },
            { title: 'Two', url: 'https://walled-b.test/two', snippet: 'walled topic snippet two' },
            { title: 'Three', url: 'https://walled-c.test/three', snippet: 'walled topic snippet three' },
          ];
        },
      },
      llm: llmFor(decisions),
    });

    assert.ok(fetches >= 3, `expected at least 3 fetch attempts, saw ${fetches}`);
    const recovery = result.quality.metrics.recovery;
    assert.ok(recovery.transportFailures >= 3, `expected transport failures, saw ${recovery.transportFailures}`);
    // Below the exploration floor a refused host must never burn the safety valve.
    assert.notEqual(result.quality.stopDetail, 'consecutive_invalid_steps');
    assert.notEqual(result.quality.stopDetail, 'transport_blocked');
    assert.ok(result.trace.some((entry) => entry.reasonCode === 'transport_blocked_read'));
    assert.deepEqual(
      Object.keys(recovery.transportBlockedHosts || {}).sort(),
      ['walled-a.test', 'walled-b.test', 'walled-c.test'],
    );
  });

  it('records refused hosts separately from search provider transients', async () => {
    registerContentFetchHandler(async () => ({
      status: 'failed',
      error: 'Timed out after 15000ms',
      errorType: 'timeout',
      httpStatus: null,
      retryable: true,
      accessStatus: 'failed',
    }));

    const decisions = [
      { action: 'search', query: 'slow topic', gapId: 'gap-1', reasonCode: 'search' },
      { action: 'read', sourceIds: ['https://slow.test/doc.pdf'], gapId: 'gap-1', reasonCode: 'read' },
      { action: 'answer', reasonCode: 'nothing_readable' },
    ];

    const result = await new ResearchRunner().run({
      query: 'slow topic',
      settings: {
        llm: {},
        search: {},
        research: {
          strategy: 'exploratory',
          exploratory: {
            minLlmTokens: 500000,
            maxLlmTokens: 800000,
            maxSteps: 8,
            maxEvaluationRetries: 0,
            autoReadTopK: 0,
            maxConsecutiveInvalidSteps: 2,
          },
          focused: { fetchMode: 'full', fetchBackend: 'auto' },
        },
      },
      search: {
        async search() {
          return [{ title: 'Doc', url: 'https://slow.test/doc.pdf', snippet: 'slow topic snippet' }];
        },
      },
      llm: llmFor(decisions),
    });

    const recovery = result.quality.metrics.recovery;
    assert.ok(recovery.transportFailures >= 1);
    assert.equal(recovery.transientFailures, 0);
    assert.equal(recovery.transportBlockedHosts['slow.test'].lastReason, 'timeout');
  });
});

describe('readiness diagnostics for unreadable required hosts', () => {
  const gap = {
    id: 'gap-1',
    question: 'What does the vendor publish officially?',
    status: 'open',
    priority: 'critical',
    requiredHosts: ['vendor.test'],
    readSourceIds: [],
  };

  function gateFor(source) {
    return evaluateReadinessGate({
      profile: { flags: {}, minIndependentSources: 1 },
      gaps: [gap],
      findings: [{ gapId: 'gap-1', question: gap.question, sources: [source] }],
    });
  }

  it('says the host refused the request when nothing was retrieved', () => {
    const failure = gateFor({
      url: 'https://vendor.test/news',
      fetchStatus: 'failed',
      fetchErrorType: 'http_4xx',
      httpStatus: 403,
    }).failures.find((item) => item.code === 'required_host_missing');
    assert.ok(failure);
    assert.match(failure.message, /refused the request/);
    assert.deepEqual(failure.hostDiagnostics, [{
      host: 'vendor.test',
      reason: 'fetch_blocked',
      detail: 'http_4xx',
      httpStatus: 403,
    }]);
  });

  it('says the body was rejected when the bytes did arrive', () => {
    const failure = gateFor({
      url: 'https://vendor.test/news',
      fetchStatus: 'ok',
      bodyQuality: 'waf',
      assessmentStatus: 'ok',
      skipReason: 'obfuscated body',
      content: '',
    }).failures.find((item) => item.code === 'required_host_missing');
    assert.ok(failure);
    assert.match(failure.message, /retrieved but no body passed/);
    assert.equal(failure.hostDiagnostics[0].reason, 'body_rejected');
    assert.equal(failure.hostDiagnostics[0].detail, 'obfuscated body');
  });

  it('says the host was never reached when it was never attempted', () => {
    const failure = gateFor({
      url: 'https://elsewhere.test/news',
      fetchStatus: 'ok',
      content: 'An unrelated host that happened to be read for this gap.',
    }).failures.find((item) => item.code === 'required_host_missing');
    assert.ok(failure);
    assert.equal(failure.hostDiagnostics[0].reason, 'not_retrieved');
  });
});

describe('first-party criterion without an assessment verdict', () => {
  const gap = {
    id: 'gap-1',
    question: 'What does the vendor say officially?',
    evidenceCriteria: ['first_party'],
    requiredHosts: ['zhipuai.cn'],
  };

  it('falls back to the hard host rule when the assessment is unavailable', () => {
    const source = {
      url: 'https://open.zhipuai.cn/announcement',
      fetchStatus: 'ok',
      contentOrigin: 'fetched',
      assessmentStatus: 'unavailable',
      assessment: { method: 'fail_closed', readability: 'uncertain', firstParty: false },
      content: 'The vendor published its own compliance filing details on this page.',
    };
    assert.equal(sourceSatisfiesCriterion(source, 'first_party', { gap }), true);
    const evaluation = evaluateEvidenceCriteria({ gap, sources: [source] });
    assert.deepEqual(evaluation.missing, []);
  });

  it('does not admit an unrelated host just because the assessment failed', () => {
    const source = {
      url: 'https://random-blog.example.com/post',
      fetchStatus: 'ok',
      contentOrigin: 'fetched',
      assessmentStatus: 'unavailable',
      assessment: { method: 'fail_closed', readability: 'uncertain', firstParty: false },
      content: 'A third-party blog summarising what the vendor supposedly announced.',
    };
    assert.equal(sourceSatisfiesCriterion(source, 'first_party', { gap }), false);
    assert.deepEqual(evaluateEvidenceCriteria({ gap, sources: [source] }).missing, ['first_party']);
  });

  it('still requires a positive verdict when the assessment did run', () => {
    const source = {
      url: 'https://open.zhipuai.cn/announcement',
      fetchStatus: 'ok',
      assessmentStatus: 'ok',
      assessment: { method: 'llm', readability: 'readable', firstParty: false },
      content: 'A reprint of the vendor announcement hosted on the vendor domain.',
    };
    assert.equal(sourceSatisfiesCriterion(source, 'first_party', { gap }), false);
  });
});
