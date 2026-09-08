import { ResearchRunner } from './helpers/legacy-research-runner.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  registerContentFetchHandler,
  resetContentFetchHandlers,
  runStrategy,
  strategyMetadata,
} from '../src/index.mjs';
import { defaultSearchQueryPlan } from './helpers/search-query-planner-mock.mjs';

function validReport(marker = 'test report', { cited = true } = {}) {
  const citation = cited ? ' [1.1]' : '';
  return `# Research Report\n\n## Summary\n\nThis ${marker} summarizes the collected evidence and clearly distinguishes verified observations from unresolved limitations. It provides enough structured prose to validate the report output contract without relying on an empty or placeholder response.${citation}\n\n## Key Findings\n\nThis ${marker} keeps a cited key finding in the labeled narrative so post-revision validation can pass without inventing unsupported claims.${citation}\n\n## Caveats\n\nThe test evidence is intentionally limited.`;
}

function checkpointSpy() {
  const boundaries = [];
  return {
    boundaries,
    event() {},
    callStarted() {},
    callFinished() {},
    checkpoint(boundary) { boundaries.push(boundary); },
  };
}

describe('ResearchRunner', () => {
  it('runs quick research with injected LLM and search adapters', async () => {
    const runner = new ResearchRunner();
    const events = [];
    const searchedQuestions = [];
    const recorder = checkpointSpy();
    const result = await runner.run({
      query: 'test topic',
      recorder,
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
        async complete({ purpose }) {
          if (purpose === 'search_query_planning') {
            return JSON.stringify({
              queries: [
                { query: 'follow up one' },
                { query: 'follow up two' },
              ],
            });
          }
          return validReport('test report [1.1]');
        },
      },
    });

    assert.match(result.report, /test report/);
    assert.deepEqual(searchedQuestions, ['test topic', 'follow up one', 'follow up two']);
    assert.ok(result.trace.some((entry) => (
      entry.action === 'search_query_planned'
      && entry.plannedQueries?.every((item) => ['user_query', 'llm_planner'].includes(item.queryOrigin))
    )));
    assert.equal(result.sources.length, 3);
    assert.equal(events[0].message, 'Research started');
    assert.ok(events.some((event) => event.message === 'Generating quick follow-up questions'));
    assert.ok(events.some((event) => event.message === 'Running 3 quick searches'));
    assert.equal(events.at(-1).message, 'Research complete');
    assert.equal(events.at(-1).progress, 100);
    assert.ok(recorder.boundaries.includes('quick-round-complete'));
    assert.ok(recorder.boundaries.includes('pre-report'));
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
    const recorder = checkpointSpy();

    const result = await runner.run({
      query: 'deep topic',
      recorder,
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
          if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
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
    assert.ok(!searchedQuestions.some((question) => question.includes('primary source evidence')));
    assert.ok(result.findings.some((finding) => finding.wave === 'discovery'));
    assert.ok(result.findings.some((finding) => finding.wave === 'repair'));
    assert.ok(result.gaps.length >= 2);
    assert.equal(result.gaps[0].priority, 'critical');
    assert.ok(result.trace.some((entry) => entry.action === 'search_wave_started' && entry.wave === 'repair'));
    assert.ok(recorder.boundaries.includes('focused-wave-complete'));
    assert.ok(recorder.boundaries.includes('focused-readiness-evaluated'));
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
    const recorder = checkpointSpy();
    const result = await runner.run({
      query: 'exploratory topic',
      recorder,
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
          if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
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
    assert.deepEqual(
      recorder.boundaries.filter((boundary) => boundary.startsWith('exploratory-')),
      [
        'exploratory-bootstrap',
        ...Array.from({ length: 6 }, () => 'exploratory-step-complete'),
        'exploratory-loop-complete',
      ],
    );
  });

  it('never exceeds a configured search request budget', async () => {
    let calls = 0;
    const result = await new ResearchRunner().run({
      query: 'budgeted topic',
      settings: { llm: {}, search: {}, research: { strategy: 'quick', iterations: 1, questionsPerIteration: 2, concurrency: 2, budget: { maxSearchRequests: 1 } } },
      search: { async search(question) { calls += 1; return [{ title: question, url: 'https://example.test', snippet: 'x' }]; } },
      llm: { async complete({ purpose }) {
        if (purpose === 'search_query_planning') {
          return JSON.stringify({ queries: [{ query: 'q1' }, { query: 'q2' }] });
        }
        return validReport('budgeted report');
      } },
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
        if (purpose === 'search_query_planning') return JSON.stringify({ queries: [] });
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

  it('cleans internal references, reasoning tags, and empty bullets before deterministic re-rendering', async () => {
    const result = await new ResearchRunner().run({
      query: 'clean report topic',
      settings: { llm: {}, search: {}, research: { strategy: 'quick', iterations: 1, questionsPerIteration: 0 } },
      search: { async search() { return [{ title: 'S', url: 'https://example.test', snippet: 'evidence' }]; } },
      llm: { async complete({ purpose }) {
        if (purpose === 'search_query_planning') return JSON.stringify({ queries: [] });
        return `</think>\n${validReport('cleanable [gap-2] report')}\n\n-   \n`;
      } },
    });

    assert.match(result.report, /cleanable report/);
    assert.doesNotMatch(result.report, /\[gap-2\]|<\/?think\b/i);
    assert.doesNotMatch(result.report, /^\s*(?:[-*]|\d+[.)])\s*$/m);
  });

  it('retries parse failures without consuming semantic-contract attempts', async () => {
    let reportAttempts = 0;
    const events = [];
    const semanticallyInvalid = JSON.stringify({
      title: 'Long but invalid report',
      summary: ['；'],
      keyFindings: [{
        heading: 'Finding',
        claims: [`This finding is long enough to exceed the report minimum but its empty summary still violates the semantic contract. ${'Supporting wording. '.repeat(12)} [1.1]`],
      }],
      caveats: [],
    });
    const result = await new ResearchRunner().run({
      query: 'parse retry topic',
      settings: { llm: {}, search: {}, research: { strategy: 'quick', iterations: 1, questionsPerIteration: 0 } },
      search: { async search() { return [{ title: 'S', url: 'https://example.test', snippet: 'evidence' }]; } },
      llm: { async complete({ purpose }) {
        if (purpose === 'search_query_planning') return JSON.stringify({ queries: [] });
        reportAttempts += 1;
        if (reportAttempts === 1) return 'prefix: {"title":"malformed","summary":[';
        if (reportAttempts === 2) return semanticallyInvalid;
        return validReport('parse retry recovery');
      } },
      onProgress: (event) => events.push(event),
    });

    assert.equal(reportAttempts, 3);
    assert.match(result.report, /parse retry recovery/);
    assert.ok(result.trace.some((entry) => entry.action === 'report_retry_requested' && entry.phase === 'parse'));
    assert.ok(result.trace.some((entry) => entry.action === 'report_retry_requested' && entry.phase === 'semantic-contract'));
    assert.equal(
      result.trace.find((entry) => entry.action === 'report_retry_requested' && entry.phase === 'parse')?.attemptCounts?.parse,
      1,
    );
    assert.equal(
      result.trace.find((entry) => entry.action === 'report_retry_requested' && entry.phase === 'semantic-contract')?.attemptCounts?.semanticContract,
      1,
    );
    assert.ok(events.some((event) => /\[parse\]/.test(event.message)));
    assert.ok(events.some((event) => /\[semantic-contract\]/.test(event.message)));
  });

  it('reports actual failing semantic checks when output exceeds the character minimum', async () => {
    const invalid = JSON.stringify({
      title: 'Long but invalid report',
      summary: ['；'],
      keyFindings: [{
        heading: 'Finding',
        claims: [`This report body is deliberately long enough to exceed the minimum while the summary remains a placeholder. ${'Detailed cited wording. '.repeat(16)} [1.1]`],
      }],
      caveats: [],
    });
    await assert.rejects(
      new ResearchRunner().run({
        query: 'semantic failure topic',
        settings: { llm: {}, search: {}, research: { strategy: 'quick', iterations: 1, questionsPerIteration: 0 } },
        search: { async search() { return [{ title: 'S', url: 'https://example.test', snippet: 'evidence' }]; } },
        llm: { async complete({ purpose }) {
          return purpose === 'search_query_planning' ? JSON.stringify({ queries: [] }) : invalid;
        } },
      }),
      (error) => {
        assert.equal(error.phase, 'semantic-contract');
        assert.ok(error.outputChars > error.minChars);
        assert.equal(error.attemptCounts.semanticContract, 2);
        assert.equal(error.attemptCounts.parse, 0);
        assert.ok(error.failedChecks.some((item) => (
          item.check === 'report_empty_summary'
          && item.actual.significantCharacters === 0
        )));
        assert.match(error.message, /report_empty_summary/);
        assert.match(error.message, /significantCharacters/);
        assert.doesNotMatch(error.message, /minimum 200 characters; received/);
        return true;
      },
    );
  });

  it('classifies persistently malformed structured output as parse failure', async () => {
    await assert.rejects(
      new ResearchRunner().run({
        query: 'parse failure topic',
        settings: { llm: {}, search: {}, research: { strategy: 'quick', iterations: 1, questionsPerIteration: 0 } },
        search: { async search() { return [{ title: 'S', url: 'https://example.test', snippet: 'evidence' }]; } },
        llm: { async complete({ purpose }) {
          return purpose === 'search_query_planning'
            ? JSON.stringify({ queries: [] })
            : 'prefix: {"title":"malformed","keyFindings":[';
        } },
      }),
      (error) => (
        error.phase === 'parse'
        && error.attemptCounts.parse === 2
        && error.attemptCounts.semanticContract === 0
        && error.failedChecks.some((item) => item.check === 'narrative_not_json')
      ),
    );
  });

  it('classifies a malformed fenced narrative after leading explanation as parse without semantic debit', async () => {
    let reportAttempts = 0;
    const result = await new ResearchRunner().run({
      query: 'fenced parse retry topic',
      settings: { llm: {}, search: {}, research: { strategy: 'quick', iterations: 1, questionsPerIteration: 0 } },
      search: { async search() { return [{ title: 'S', url: 'https://example.test', snippet: 'evidence' }]; } },
      llm: { async complete({ purpose }) {
        if (purpose === 'search_query_planning') return JSON.stringify({ queries: [] });
        reportAttempts += 1;
        if (reportAttempts === 1) {
          return 'Here is the requested object:\n```json\n{"title":"broken","summary":[';
        }
        return validReport('fenced parse recovery');
      } },
    });

    const parseRetry = result.trace.find((entry) => (
      entry.action === 'report_retry_requested' && entry.phase === 'parse'
    ));
    assert.equal(reportAttempts, 2);
    assert.equal(parseRetry?.attemptCounts?.parse, 1);
    assert.equal(parseRetry?.attemptCounts?.semanticContract, 0);
  });

  it('does not classify ordinary Markdown braces as structured narrative', async () => {
    let reportAttempts = 0;
    const result = await new ResearchRunner().run({
      query: 'markdown braces topic',
      settings: { llm: {}, search: {}, research: { strategy: 'quick', iterations: 1, questionsPerIteration: 0 } },
      search: { async search() { return [{ title: 'S', url: 'https://example.test', snippet: 'evidence' }]; } },
      llm: { async complete({ purpose }) {
        if (purpose === 'search_query_planning') return JSON.stringify({ queries: [] });
        reportAttempts += 1;
        return validReport('Markdown with an ordinary {example: value} object');
      } },
    });

    assert.equal(reportAttempts, 1);
    assert.match(result.report, /\{example: value\}/);
    assert.equal(result.trace.some((entry) => entry.phase === 'parse'), false);
  });

  it('rejects a persistently empty report instead of completing', async () => {
    await assert.rejects(
      new ResearchRunner().run({
        query: 'empty report topic',
        settings: { llm: {}, search: {}, research: { strategy: 'quick', iterations: 1, questionsPerIteration: 0 } },
        search: { async search() { return [{ title: 'S', url: 'https://example.test', snippet: 'evidence' }]; } },
        llm: { async complete({ purpose }) { return purpose === 'search_query_planning' ? JSON.stringify({ queries: [] }) : ''; } },
      }),
      (error) => (
        error.name === 'ReportGenerationError'
        && error.code === 'REPORT_OUTPUT_INVALID'
        && error.attempts === 2
        && error.phase === 'provider'
        && error.attemptCounts.provider === 2
        && error.attemptCounts.parse === 0
        && error.attemptCounts.semanticContract === 0
      ),
    );
  });

  it('completes a closed judgment report when Key Findings use H3 groups and repeat the Summary', async () => {
    const FIRST_PARTY_BODY = 'Anthropic published Commerce Agents as an open-source blueprint. Retailers can fork the reference implementation and keep checkout on their own site.';
    const summary = 'Anthropic 把 Commerce Agents 写成可 fork 的开源蓝图，零售商可以在自己的站点完成结账，而不是把货架标准锁进闭源平台。 [1.1]';
    const recorder = checkpointSpy();
    let reportPromptText = '';
    const result = await new ResearchRunner().run({
      query: 'Anthropic Commerce Agents official design judgment',
      recorder,
      settings: {
        llm: {},
        search: {},
        research: {
          strategy: 'focused',
          iterations: 1,
          questionsPerIteration: 0,
          quality: { entailment: 'rules' },
          focused: {
            fetchMode: 'disabled',
            iterationControl: { enabled: false },
            evidencePassages: { enabled: true, claimAlignment: true },
          },
        },
      },
      search: {
        async search() {
          return [{
            title: 'Commerce Agents',
            url: 'https://www.claude.com/blog/commerce-agents',
            content: FIRST_PARTY_BODY,
            fetchStatus: 'ok',
            contentOrigin: 'fetched',
            assessment: { firstParty: true, publisherType: 'official', contentKind: 'article' },
          }];
        },
      },
      llm: {
        async complete({ purpose, messages }) {
          if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
          if (purpose === 'research_profile') {
            return JSON.stringify({
              queryShape: 'judgment',
              requiredAnswerSlots: [{
                id: 'judgment',
                answerSlot: 'judgment',
                question: 'Does Commerce Agents keep the shelf with the retailer?',
                evidenceCriteria: ['first_party'],
              }],
            });
          }
          if (purpose === 'gap_support') {
            return JSON.stringify({
              judgments: [{ verdict: 'supported', quote: 'Retailers can fork the reference implementation and keep checkout on their own site.' }],
            });
          }
          if (purpose === 'question_generation') return '[]';
          if (purpose === 'report') {
            reportPromptText = (messages || []).map((item) => item.content).join('\n');
            return JSON.stringify({
              title: 'Commerce Agents 判断',
              summary: [summary],
              backgroundFacts: ['Anthropic published Commerce Agents as an open-source blueprint. [1.1]'],
              keyFindings: [{ heading: '判断', claims: [summary] }],
              caveats: [],
            });
          }
          return '{}';
        },
      },
    });
    assert.ok(recorder.boundaries.includes('report-contract'));
    assert.ok(recorder.boundaries.includes('report-plan'));
    assert.match(result.report.split('## Evidence')[0], /## Key Findings/);
    assert.match(result.report, /可 fork 的开源蓝图/);
    assert.equal(result.reportContract?.openJudgment, false);
    assert.ok((result.reportPlan?.keyFindings || []).some((group) => (group.claims || []).length));
    assert.doesNotMatch(reportPromptText, /only as Confirmed Background Facts while the judgment slot remains open/);
    assert.doesNotMatch(result.report.split('## Evidence')[0], /still unresolved|仍未关闭/);
  });

  it('cannot let one answered slot and an unrelated Key Finding satisfy a two-slot contract', async () => {
    const answerA = 'Alpha remains enabled for production deployments.';
    const answerB = 'Beta requires an explicit compatibility flag for production deployments.';
    const result = await new ResearchRunner().run({
      query: 'Compare Alpha and Beta production deployment requirements',
      settings: {
        llm: {},
        search: {},
        research: {
          strategy: 'focused',
          iterations: 1,
          questionsPerIteration: 0,
          quality: { entailment: 'rules' },
          focused: {
            fetchMode: 'disabled',
            iterationControl: { enabled: false },
            evidencePassages: { enabled: true, claimAlignment: true },
          },
        },
      },
      search: {
        async search(question) {
          const beta = /Beta/i.test(question);
          const answer = beta ? answerB : answerA;
          return [{
            title: beta ? 'Beta production guide' : 'Alpha production guide',
            url: beta ? 'https://docs.example.com/beta' : 'https://docs.example.com/alpha',
            content: `${question}. ${answer} ${'Official deployment documentation supplies directly anchored evidence. '.repeat(4)}`,
            fetchStatus: 'ok',
            contentOrigin: 'fetched',
            assessment: { firstParty: true, publisherType: 'official', contentKind: 'documentation' },
          }];
        },
      },
      llm: {
        async complete({ purpose, messages }) {
          if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
          if (purpose === 'research_profile') {
            return JSON.stringify({
              queryShape: 'comparison',
              requiredAnswerSlots: [
                { answerSlot: 'alpha-slot', question: 'Alpha production requirements' },
                { answerSlot: 'beta-slot', question: 'Beta production requirements' },
              ],
            });
          }
          if (purpose === 'gap_support') {
            return JSON.stringify({
              judgments: [
                { answerSlot: 'alpha-slot', verdict: 'supported', quote: answerA },
                { answerSlot: 'beta-slot', verdict: 'supported', quote: answerB },
              ],
            });
          }
          if (purpose === 'question_generation') return '[]';
          if (purpose === 'report') {
            return JSON.stringify({
              title: 'Alpha and Beta production requirements',
              summary: [`Alpha has a documented production path, while every required comparison slot remains independently contract-bound. ${answerA} [1.1]`],
              keyFindings: [{
                heading: 'Partial LLM answer',
                claims: [
                  `${answerA} [1.1]`,
                  'An unrelated deployment observation cannot answer the missing Beta slot. [1.1]',
                ],
              }],
              caveats: [],
            });
          }
          return '{}';
        },
      },
    });

    assert.equal(result.reportContract.verifiedSlotIds.length, 2);
    assert.equal(result.quality.reportContractSatisfied, true);
    assert.match(result.report.split('## Evidence')[0], new RegExp(answerB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const boundSlotIds = new Set(
      result.reportPlan.keyFindings
        .flatMap((group) => group.claims || [])
        .flatMap((claim) => claim.boundSlotIds || []),
    );
    assert.deepEqual([...boundSlotIds].sort(), [...result.reportContract.verifiedSlotIds].sort());
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
      llm: { async complete({ purpose, messages }) {
        if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
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
        return purpose === 'question_generation'
          ? JSON.stringify(['secondary comparison'])
          : validReport('limited focused report', { cited: false });
      } },
    });
    assert.ok(result.gaps.some((gap) => gap.priority === 'critical'));
    assert.ok(result.gaps.some((gap) => ['open', 'searched', 'body_read'].includes(gap.status)));
    assert.ok(result.quality.flags.includes('critical_gaps_open'));
    assert.ok(result.quality.flags.includes('primary_source_missing'));
    assert.ok(result.quality.flags.includes('no_direct_evidence'));
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
      llm: { async complete({ purpose, messages }) {
        if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
        if (purpose === 'research_profile') {
          return JSON.stringify({
            requiredAnswerSlots: [{ answerSlot: 'same unresolved question', question: 'same unresolved question' }],
          });
        }
        return purpose === 'question_generation'
          ? JSON.stringify(['same unresolved question'])
          : validReport('duplicate gap report', { cited: false });
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
          async complete({ purpose, messages }) {
            if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
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
          async complete({ purpose, messages }) {
            if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
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

  it('skips focused search waves when the planner fails and does not splice a fallback query', async () => {
    const searched = [];
    const result = await new ResearchRunner().run({
      query: 'planner failure topic',
      settings: {
        llm: {},
        search: {},
        research: {
          strategy: 'focused',
          iterations: 1,
          questionsPerIteration: 1,
          focused: { fetchMode: 'disabled', challenge: { enabled: false }, iterationControl: { enabled: false } },
        },
      },
      search: {
        async search(question) {
          searched.push(question);
          return [{ title: question, url: 'https://example.test/a', snippet: 'x' }];
        },
      },
      llm: {
        async complete({ purpose }) {
          if (purpose === 'search_query_planning') return JSON.stringify({ queries: [] });
          if (purpose === 'research_profile') {
            return JSON.stringify({
              requiredAnswerSlots: [{ answerSlot: 'topic', question: 'planner failure topic' }],
            });
          }
          return validReport('planner failure report');
        },
      },
    });
    assert.deepEqual(searched, []);
    assert.ok(!result.trace.some((entry) => /primary source evidence/.test(String(entry.query || ''))));
    assert.ok(result.trace.some((entry) => entry.skipped === 'query_planner_failed' || entry.failure));
  });
});
