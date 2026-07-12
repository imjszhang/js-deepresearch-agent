import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ResearchRunner, runStrategy, strategyMetadata } from '../src/index.mjs';

function validReport(marker = 'test report') {
  return `# Research Report\n\n## Summary\n\nThis ${marker} summarizes the collected evidence and clearly distinguishes verified observations from unresolved limitations. It provides enough structured prose to validate the report output contract without relying on an empty or placeholder response.\n\n## Caveats\n\nThe test evidence is intentionally limited.`;
}

describe('ResearchRunner', () => {
  it('runs rapid research with injected LLM and search adapters', async () => {
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
          strategy: 'rapid',
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
    assert.ok(events.some((event) => event.message === 'Generating rapid follow-up questions'));
    assert.ok(events.some((event) => event.message === 'Running 3 rapid searches'));
    assert.equal(events.at(-1).message, 'Research complete');
    assert.equal(events.at(-1).progress, 100);
  });

  it('exposes available research strategies as metadata', () => {
    assert.deepEqual(strategyMetadata.map((strategy) => strategy.id), [
      'rapid',
      'source-based',
      'parallel',
      'adaptive',
    ]);
    assert.equal(strategyMetadata[0].supportsConcurrency, true);
  });

  it('runs source-based research across configured iterations', async () => {
    const searchedQuestions = [];
    const runner = new ResearchRunner();

    const result = await runner.run({
      query: 'deep topic',
      settings: {
        llm: {},
        search: {},
        research: {
          strategy: 'source-based',
          iterations: 2,
          questionsPerIteration: 1,
          concurrency: 1,
          sourceBased: {
            fetchMode: 'disabled',
            adaptiveControl: { enabled: false },
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
        async complete({ messages }) {
          if (messages[0].content.includes('research planner')) {
            return messages[1].content.includes('Context:')
              ? JSON.stringify(['second iteration question'])
              : JSON.stringify(['first iteration question']);
          }
          return validReport('source-based report');
        },
      },
    });

    assert.deepEqual(searchedQuestions, [
      'deep topic',
      'first iteration question',
      'second iteration question',
    ]);
    assert.deepEqual(result.findings.map((finding) => finding.iteration), [1, 1, 2]);
    assert.equal(result.gaps.length, 3);
    assert.equal(result.gaps[0].priority, 'critical');
  });

  it('rejects unsupported research strategies', async () => {
    await assert.rejects(
      runStrategy({ strategy: 'unknown' }),
      /Unsupported research strategy: unknown/,
    );
  });

  it('runs the experimental adaptive strategy with structured trace and gaps', async () => {
    const events = [];
    const runner = new ResearchRunner();
    const result = await runner.run({
      query: 'adaptive topic',
      settings: {
        llm: {}, search: {},
        research: {
          strategy: 'adaptive', concurrency: 2,
          budget: { maxSearchRequests: 5, maxSourceReads: 0, maxLlmTokens: 0 },
          adaptive: { maxSteps: 10, maxOpenGaps: 3, maxQueriesPerStep: 2, plannerParallelism: 2 },
          sourceBased: { fetchMode: 'disabled', sourceSelection: { enabled: true, maxPerHostname: 2 } },
        },
      },
      onProgress: (event) => events.push(event.message),
      search: { async search(question) { return [{ title: question, url: `https://example.com/${encodeURIComponent(question)}`, snippet: 'evidence' }]; } },
      llm: { async complete({ messages }) { return messages[0].content.includes('research planner') ? JSON.stringify(['gap two']) : validReport('adaptive evidence report'); } },
    });
    assert.ok(result.gaps.length >= 2);
    assert.ok(result.trace.some((entry) => entry.action === 'plan'));
    assert.ok(result.trace.some((entry) => entry.action === 'evaluate_gap'));
    assert.ok(result.trace.filter((entry) => !['llm_call', 'draft'].includes(entry.action)).length <= 10);
    assert.equal(result.trace.at(-1).action, 'stop');
    assert.ok(events.includes('Assessing research query'));
  });

  it('never exceeds a configured search request budget', async () => {
    let calls = 0;
    const result = await new ResearchRunner().run({
      query: 'budgeted topic',
      settings: { llm: {}, search: {}, research: { strategy: 'rapid', questionsPerIteration: 2, concurrency: 2, budget: { maxSearchRequests: 1 } } },
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
      settings: { llm: {}, search: {}, research: { strategy: 'rapid', questionsPerIteration: 0 } },
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
        settings: { llm: {}, search: {}, research: { strategy: 'rapid', questionsPerIteration: 0 } },
        search: { async search() { return [{ title: 'S', url: 'https://example.test', snippet: 'evidence' }]; } },
        llm: { async complete({ purpose }) { return purpose === 'question_generation' ? '[]' : ''; } },
      }),
      (error) => error.name === 'ReportGenerationError' && error.code === 'REPORT_OUTPUT_INVALID' && error.attempts === 2,
    );
  });

  it('records source-based critical gaps and evidence limitations', async () => {
    const result = await new ResearchRunner().run({
      query: 'compare open source framework architecture',
      settings: { llm: {}, search: {}, research: {
        strategy: 'source-based', iterations: 1, questionsPerIteration: 1, concurrency: 1,
        sourceBased: { fetchMode: 'disabled', adaptiveControl: { enabled: false } },
      } },
      search: { async search(question) {
        return question === 'compare open source framework architecture'
          ? []
          : [{ title: 'Secondary article', url: 'https://blog.csdn.net/secondary', snippet: 'overview' }];
      } },
      llm: { async complete({ purpose }) {
        return purpose === 'question_generation' ? JSON.stringify(['secondary comparison']) : validReport('limited source-based report');
      } },
    });
    assert.equal(result.gaps[0].priority, 'critical');
    assert.equal(result.gaps[0].status, 'open');
    assert.ok(result.quality.flags.includes('critical_gaps_open'));
    assert.ok(result.quality.flags.includes('primary_source_missing'));
    assert.ok(result.quality.flags.includes('no_direct_evidence'));
    assert.ok(result.quality.limitations.some((item) => /primary or official/i.test(item)));
    assert.equal(result.quality.gate, 'pass_with_warnings');
  });

  it('deduplicates repeated source-based gaps and reports the remaining open count', async () => {
    const result = await new ResearchRunner().run({
      query: 'duplicate gap topic',
      settings: { llm: {}, search: {}, research: {
        strategy: 'source-based', iterations: 2, questionsPerIteration: 1, concurrency: 1,
        budget: { maxSourceReads: 1 },
        sourceBased: { fetchMode: 'disabled', adaptiveControl: { enabled: false } },
      } },
      search: { async search() { return []; } },
      llm: { async complete({ purpose }) { return purpose === 'question_generation' ? JSON.stringify(['same unresolved question']) : validReport('duplicate gap report'); } },
    });
    assert.equal(result.gaps.filter((gap) => gap.question === 'same unresolved question').length, 1);
    assert.equal(result.quality.metrics.openGapCount, 2);
  });
});
