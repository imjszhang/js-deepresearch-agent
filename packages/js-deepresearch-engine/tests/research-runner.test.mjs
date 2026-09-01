import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ResearchRunner,
  registerContentFetchHandler,
  resetContentFetchHandlers,
  runStrategy,
  strategyMetadata,
} from '../src/index.mjs';

function validReport(marker = 'test report') {
  return `# Research Report\n\n## Summary\n\nThis ${marker} summarizes the collected evidence and clearly distinguishes verified observations from unresolved limitations. It provides enough structured prose to validate the report output contract without relying on an empty or placeholder response.\n\n## Caveats\n\nThe test evidence is intentionally limited.`;
}

describe('ResearchRunner', () => {
  it('runs quick research with injected LLM and search adapters', async () => {
    const runner = new ResearchRunner();
    const events = [];
    const searchedQuestions = [];
    const result = await runner.run({
      query: 'test topic',
      settings: {
        llm: {
          provider: 'openai-compatible',
          model: 'mock',
          apiKey: 'test',
          baseUrl: 'mock://llm',
          temperature: 0,
          maxTokens: 100,
        },
        search: {
          engine: 'searxng',
          baseUrl: 'mock://search',
          maxResults: 2,
        },
        research: {
          strategy: 'quick',
          iterations: 1,
          questionsPerIteration: 2,
          concurrency: 2,
        },
      },
      onProgress: (event) => events.push(event),
      search: {
        async search(question) {
          searchedQuestions.push(question);
          return [{ title: `Source for ${question}`, url: `https://example.com/${searchedQuestions.length}`, snippet: 'Evidence' }];
        },
      },
      llm: {
        async complete({ messages }) {
          if (messages[0].content.includes('research planner')) {
            return JSON.stringify(['follow up one', 'follow up two']);
          }
          return validReport('test report [1.1]');
        },
      },
    });

    assert.match(result.report, /test report/);
    assert.deepEqual(searchedQuestions, ['test topic', 'follow up one', 'follow up two']);
    assert.equal(result.sources.length, 3);
    assert.equal(events[0].message, 'Research started');
    assert.ok(events.some((event) => event.message === 'Generating quick follow-up questions'));
    assert.ok(events.some((event) => event.message === 'Running 3 quick searches'));
    assert.equal(events.at(-1).message, 'Research complete');
    assert.equal(events.at(-1).progress, 100);
  });

  it('exposes available research strategies as metadata', () => {
    assert.deepEqual(strategyMetadata.map((strategy) => strategy.id), [
      'quick',
      'focused',
      'exploratory',
    ]);
    assert.equal(strategyMetadata[0].supportsConcurrency, true);
  });

  it('runs focused discovery and targeted repair waves', async () => {
    const searchedQuestions = [];
    const runner = new ResearchRunner();

    const result = await runner.run({
      query: 'deep topic',
      settings: {
        llm: {},
        search: {},
        research: {
          strategy: 'focused',
          iterations: 2,
          questionsPerIteration: 1,
          concurrency: 1,
          focused: {
            fetchMode: 'disabled',
            iterationControl: { enabled: false },
          },
        },
      },
      search: {
        async search(question) {
          searchedQuestions.push(question);
          return [{ title: question, url: `https://example.com/${searchedQuestions.length}`, snippet: `Snippet for ${question}` }];
        },
      },
      llm: {
        async complete({ purpose, messages }) {
          if (purpose === 'research_profile') {
            return JSON.stringify({
              requiredAnswerSlots: [
                { answerSlot: 'deep topic', question: 'deep topic', priority: 'critical' },
                { answerSlot: 'first iteration question', question: 'first iteration question' },
              ],
            });
          }
          if (messages[0].content.includes('research planner')) {
            return messages[1].content.includes('Context:')
              ? JSON.stringify(['second iteration question'])
              : JSON.stringify(['first iteration question']);
          }
          return validReport('focused report');
        },
      },
    });

    assert.ok(searchedQuestions.includes('deep topic'));
    assert.ok(searchedQuestions.includes('first iteration question'));
    assert.ok(searchedQuestions.some((question) => question.includes('primary source evidence')));
    assert.ok(result.findings.some((finding) => finding.wave === 'discovery'));
    assert.ok(result.findings.some((finding) => finding.wave === 'repair'));
    assert.ok(result.gaps.length >= 2);
    assert.equal(result.gaps[0].priority, 'critical');
    assert.ok(result.trace.some((entry) => entry.action === 'search_wave_started' && entry.wave === 'repair'));
  });

  it('rejects unsupported research strategies', async () => {
    await assert.rejects(
      runStrategy({ strategy: 'unknown' }),
      /Unsupported research strategy: unknown/,
    );
  });

  it('runs exploratory research with the agent loop', async () => {
    const events = [];
    const decisions = [
      { action: 'search', query: 'exploratory topic', gapId: 'gap-1', reasonCode: 'find_sources' },
      { action: 'read', sourceIds: ['https://example.com/exploratory%20topic'], gapId: 'gap-1', reasonCode: 'read' },
      { action: 'answer', reasonCode: 'evidence_sufficient' },
    ];
    const runner = new ResearchRunner();
    const result = await runner.run({
      query: 'exploratory topic',
      settings: {
        llm: {}, search: {},
        research: {
          strategy: 'exploratory', concurrency: 2,
          budget: { maxSearchRequests: 5, maxSourceReads: 0, maxLlmTokens: 0 },
          exploratory: { maxSteps: 6, maxOpenGaps: 3, maxQueriesPerStep: 2, maxEvaluationRetries: 0, autoReadTopK: 0 },
          focused: { fetchMode: 'disabled', sourceSelection: { enabled: true, maxPerHostname: 2 } },
        },
      },
      onProgress: (event) => events.push(event.message),
      search: { async search(question) { return [{ title: question, url: `https://example.com/${encodeURIComponent(question)}`, snippet: 'evidence', content: 'usable evidence', fetchStatus: 'ok' }]; } },
      llm: {
        async complete({ purpose, messages }) {
          if (purpose === 'agent_decision') return JSON.stringify(decisions.shift());
          if (purpose === 'gap_decomposition') return '{"subQuestions":["gap two"]}';
          if (purpose === 'research_profile') {
            return JSON.stringify({
              requiredAnswerSlots: [{ answerSlot: 'topic', question: 'topic evidence', priority: 'normal' }],
              minIndependentSources: 1,
            });
          }
          if (purpose === 'gap_support') {
            const text = (messages || []).map((item) => item.content).join('\n');
            const quote = (text.match(/\] ([^\n]+)/) || [])[1] || 'usable evidence from a selected source.';
            return JSON.stringify({ judgments: [{ verdict: 'supported', quote }] });
          }
          return validReport('exploratory evidence report');
        },
      },
    });
    assert.ok(result.gaps.length >= 1);
    assert.ok(result.trace.some((entry) => entry.action === 'search' || entry.reasonCode === 'agent_loop_v2'));
    assert.equal(result.trace.at(-1).action, 'stop');
    assert.ok(events.includes('Assessing research query'));
  });

  it('never exceeds a configured search request budget', async () => {
    let calls = 0;
    const result = await new ResearchRunner().run({
      query: 'budgeted topic',
      settings: { llm: {}, search: {}, research: { strategy: 'quick', iterations: 1, questionsPerIteration: 2, concurrency: 2, budget: { maxSearchRequests: 1 } } },
      search: { async search(question) { calls += 1; return [{ title: question, url: 'https://example.test', snippet: 'x' }]; } },
      llm: { async complete({ messages }) { return messages[0].content.includes('research planner') ? JSON.stringify(['q1', 'q2']) : validReport('budgeted report'); } },
    });
    assert.equal(calls, 1);
    assert.equal(result.quality.budget.usage.searchRequests, 1);
    assert.equal(result.quality.budget.stopReason, 'searchRequests');
  });

  it('retries an invalid report once and records safe LLM telemetry', async () => {
    let reportAttempts = 0;
    const events = [];
    const result = await new ResearchRunner().run({
      query: 'retry topic',
      settings: { llm: {}, search: {}, research: { strategy: 'quick', iterations: 1, questionsPerIteration: 0 } },
      search: { async search() { return [{ title: 'S', url: 'https://example.test', snippet: 'evidence' }]; } },
      llm: { async complete({ purpose }) {
        if (purpose === 'question_generation') return '[]';
        reportAttempts += 1;
        return reportAttempts === 1 ? '' : validReport('retried report');
      } },
      onProgress: (event) => events.push(event),
    });
    assert.equal(reportAttempts, 2);
    assert.match(result.report, /retried report/);
    assert.ok(result.trace.some((entry) => entry.action === 'report_retry_requested' && entry.reasonCode === 'empty_report'));
    assert.ok(result.trace.some((entry) => entry.action === 'llm_call' && entry.purpose === 'report' && entry.outputChars === 0));
    assert.ok(events.some((event) => /retrying/.test(event.message)));
  });

  it('rejects a persistently empty report instead of completing', async () => {
    await assert.rejects(
      new ResearchRunner().run({
        query: 'empty report topic',
        settings: { llm: {}, search: {}, research: { strategy: 'quick', iterations: 1, questionsPerIteration: 0 } },
        search: { async search() { return [{ title: 'S', url: 'https://example.test', snippet: 'evidence' }]; } },
        llm: { async complete({ purpose }) { return purpose === 'question_generation' ? '[]' : ''; } },
      }),
      (error) => error.name === 'ReportGenerationError' && error.code === 'REPORT_OUTPUT_INVALID' && error.attempts === 2,
    );
  });

  it('records focused critical gaps and evidence limitations', async () => {
    const result = await new ResearchRunner().run({
      query: 'compare open source framework architecture',
      settings: { llm: {}, search: {}, research: {
        strategy: 'focused', iterations: 1, questionsPerIteration: 1, concurrency: 1,
        focused: { fetchMode: 'disabled', iterationControl: { enabled: false } },
      } },
      search: { async search(question) {
        return question === 'compare open source framework architecture'
          ? []
          : [{ title: 'Secondary article', url: 'https://blog.csdn.net/secondary', snippet: 'overview' }];
      } },
      llm: { async complete({ purpose }) {
        if (purpose === 'research_profile') {
          return JSON.stringify({
            requiredAnswerSlots: [
              {
                answerSlot: 'architecture',
                question: 'compare open source framework architecture',
                priority: 'critical',
              },
              {
                answerSlot: 'secondary comparison',
                question: 'secondary comparison',
                priority: 'normal',
              },
            ],
          });
        }
        return purpose === 'question_generation' ? JSON.stringify(['secondary comparison']) : validReport('limited focused report');
      } },
    });
    assert.ok(result.gaps.some((gap) => gap.priority === 'critical'));
    assert.ok(result.gaps.some((gap) => ['open', 'searched', 'body_read'].includes(gap.status)));
    assert.ok(result.quality.flags.includes('critical_gaps_open'));
    assert.ok(result.quality.flags.includes('primary_source_missing'));
    assert.ok(result.quality.flags.includes('no_direct_evidence'));
    assert.ok(result.quality.limitations.some((item) => /primary or official/i.test(item)));
    assert.equal(result.quality.gate, 'pass_with_warnings');
  });

  it('deduplicates repeated focused gaps and reports the remaining open count', async () => {
    const result = await new ResearchRunner().run({
      query: 'duplicate gap topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'focused', iterations: 2, questionsPerIteration: 1, concurrency: 1,
        budget: { maxSourceReads: 1 },
        focused: { fetchMode: 'disabled', iterationControl: { enabled: false } },
      } },
      search: { async search() { return []; } },
      llm: { async complete({ purpose }) {
        if (purpose === 'research_profile') {
          return JSON.stringify({
            requiredAnswerSlots: [{ answerSlot: 'same unresolved question', question: 'same unresolved question' }],
          });
        }
        return purpose === 'question_generation' ? JSON.stringify(['same unresolved question']) : validReport('duplicate gap report');
      } },
    });
    assert.equal(result.gaps.filter((gap) => gap.question === 'same unresolved question').length, 1);
    assert.ok(result.quality.metrics.openGapCount >= 1);
  });

  it('preserves the verified rollup root after final evidence recalculation', async () => {
    const body = [
      'SubjectA publishes a first-party guide that directly confirms production support for the requested topic.',
      'The guide includes enough detailed body text to satisfy deterministic body-quality checks and anchor the required slot quote.',
    ].join(' ');
    registerContentFetchHandler(async (url) => (
      url === 'https://docs.example.com/topic'
        ? { status: 'ok', content: body, backend: 'test' }
        : { status: 'unsupported' }
    ));

    try {
      const result = await new ResearchRunner().run({
        query: 'SubjectA production support',
        settings: {
          llm: {},
          search: {},
          research: {
            strategy: 'focused',
            iterations: 1,
            questionsPerIteration: 0,
            concurrency: 1,
            focused: {
              fetchMode: 'full',
              iterationControl: { enabled: false },
            },
          },
        },
        search: {
          async search() {
            return [{
              title: 'SubjectA guide',
              url: 'https://docs.example.com/topic',
              snippet: 'SubjectA production support guide.',
            }];
          },
        },
        llm: {
          async complete({ purpose }) {
            if (purpose === 'research_profile') {
              return JSON.stringify({
                requiredAnswerSlots: [{
                  answerSlot: 'production support',
                  question: 'SubjectA production support',
                  priority: 'critical',
                }],
                minIndependentSources: 1,
              });
            }
            if (purpose === 'gap_support') {
              return JSON.stringify({
                judgments: [{
                  verdict: 'supported',
                  quote: 'SubjectA publishes a first-party guide that directly confirms production support for the requested topic.',
                }],
              });
            }
            return validReport('verified rollup report [1.1]');
          },
        },
      });

      const root = result.gaps.find((gap) => gap.rollup);
      const slot = result.gaps.find((gap) => gap.requiredSlot);
      assert.equal(slot?.status, 'verified');
      assert.equal(root?.status, 'verified');
      assert.equal(root?.resolutionReason, 'All required answer slots were verified.');
    } finally {
      resetContentFetchHandlers();
    }
  });

  it('does not borrow another slot body during final evidence recalculation', async () => {
    const bodies = {
      'https://docs-a.example/topic': 'SubjectA official guide directly confirms its supported status with enough detailed source body text for deterministic evidence checks.',
      'https://docs-b.example/topic': 'SubjectB official guide directly confirms its supported status with enough detailed source body text for deterministic evidence checks.',
    };
    registerContentFetchHandler(async (url) => (
      bodies[url]
        ? { status: 'ok', content: bodies[url], backend: 'test' }
        : { status: 'unsupported' }
    ));

    try {
      const result = await new ResearchRunner().run({
        query: 'Compare SubjectA and SubjectB status',
        settings: {
          llm: {},
          search: {},
          research: {
            strategy: 'focused',
            iterations: 1,
            questionsPerIteration: 0,
            concurrency: 1,
            focused: {
              fetchMode: 'full',
              iterationControl: { enabled: false },
            },
          },
        },
        search: {
          async search(question) {
            const subject = question.includes('SubjectA') ? 'a' : 'b';
            return [{
              title: `Subject${subject.toUpperCase()} guide`,
              url: `https://docs-${subject}.example/topic`,
              snippet: `Subject${subject.toUpperCase()} status guide.`,
            }];
          },
        },
        llm: {
          async complete({ purpose }) {
            if (purpose === 'research_profile') {
              return JSON.stringify({
                requiredAnswerSlots: [
                  { answerSlot: 'SubjectA status', question: 'SubjectA status', priority: 'critical' },
                  { answerSlot: 'SubjectB status', question: 'SubjectB status', priority: 'critical' },
                ],
                minIndependentSources: 2,
              });
            }
            if (purpose === 'gap_support') {
              return JSON.stringify({
                judgments: [
                  {
                    gapId: 'gap-2',
                    verdict: 'supported',
                    quote: 'SubjectA official guide directly confirms its supported status',
                  },
                  {
                    gapId: 'gap-3',
                    verdict: 'supported',
                    quote: 'SubjectB official guide directly confirms its supported status',
                  },
                ],
              });
            }
            return validReport('slot-scoped evidence report [1.1]');
          },
        },
      });

      const slots = result.gaps.filter((gap) => gap.requiredSlot);
      assert.equal(slots.length, 2);
      assert.ok(slots.every((gap) => gap.status === 'limited'));
      assert.ok(slots.every((gap) => gap.missingEvidence.includes('independent_sources')));
      assert.equal(result.gaps.find((gap) => gap.rollup)?.status, 'limited');
    } finally {
      resetContentFetchHandlers();
    }
  });
});
