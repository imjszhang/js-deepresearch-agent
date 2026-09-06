import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  BudgetManager,
  FileRunRecorder,
  ReportGenerationError,
  ResearchRunner,
  loadLatestCheckpoint,
  readEventJournal,
  registerContentFetchHandler,
  resetContentFetchHandlers,
  replayRecordedLlmCall,
  sanitizeRecordedValue,
  validateReportOutput,
} from '../src/index.mjs';
import { OpenAICompatibleProvider } from '../src/llm/providers/openai-compatible.mjs';
import { wrapProvidersWithBudget } from '../src/research/budget-manager.mjs';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';
import { QueryMemory } from '../src/research/query-memory.mjs';
import { enrichFindings } from '../src/research/source-enricher.mjs';

describe('durable run recorder', () => {
  const tempDirs = [];

  afterEach(() => {
    resetContentFetchHandlers();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeSession() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-recorder-'));
    tempDirs.push(root);
    return path.join(root, 'work_dir', 'exploratory', '2026-09-05_120000');
  }

  it('atomically records checkpoints and redacts credentials without redacting token counts', () => {
    const sessionDir = makeSession();
    const recorder = new FileRunRecorder({
      sessionDir,
      runId: 'run-1',
      strategy: 'exploratory',
      query: 'test query',
      metadata: {
        settings: {
          llm: { apiKey: 'top-secret', maxTokens: 4096 },
          http: { proxy: 'socks5://user:pass@127.0.0.1:1080' },
        },
      },
    });
    recorder.checkpoint('step-complete', {
      usage: { totalTokens: 321 },
      values: new Set(['a']),
      cache: new Map([['x', { score: 1 }]]),
    });
    recorder.finalize('failed', { error: new Error('boom') });

    const run = JSON.parse(fs.readFileSync(path.join(sessionDir, 'run.json'), 'utf8'));
    assert.equal(run.status, 'failed');
    assert.equal(run.settings.llm.apiKey, '[redacted]');
    assert.equal(run.settings.llm.maxTokens, 4096);
    assert.equal(run.settings.http.proxy, 'socks5://127.0.0.1:1080');
    assert.doesNotMatch(run.settings.http.proxy, /user:pass/);

    const checkpoint = JSON.parse(
      fs.readFileSync(path.join(sessionDir, run.latestCheckpoint), 'utf8'),
    );
    const latest = JSON.parse(
      fs.readFileSync(path.join(sessionDir, 'checkpoints', 'latest.json'), 'utf8'),
    );
    assert.equal(latest.checkpointId, checkpoint.checkpointId);
    const state = JSON.parse(
      fs.readFileSync(path.join(sessionDir, checkpoint.state.path), 'utf8'),
    );
    assert.equal(state.usage.totalTokens, 321);
    assert.deepEqual(state.values, ['a']);
    assert.deepEqual(state.cache, [['x', { score: 1 }]]);
    assert.equal(fs.readdirSync(sessionDir, { recursive: true }).some((name) => name.includes('.tmp-')), false);
    assert.equal(fs.statSync(path.join(sessionDir, 'run.json')).mode & 0o077, 0);
    const allSessionText = fs.readdirSync(sessionDir, { recursive: true })
      .map((name) => path.join(sessionDir, name))
      .filter((file) => fs.statSync(file).isFile())
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    assert.doesNotMatch(allSessionText, /top-secret|user:pass/);
    assert.equal(loadLatestCheckpoint(sessionDir).state.usage.totalTokens, 321);
    fs.appendFileSync(path.join(sessionDir, 'journal', 'events.jsonl'), '{"partial":');
    const events = readEventJournal(sessionDir);
    assert.ok(events.some((event) => event.type === 'session_finished'));
    assert.ok(events.every((event) => event.operationId && 'parentOperationId' in event));
  });

  it('records report failed checks and the last failure phase in failure.json', () => {
    const sessionDir = makeSession();
    const recorder = new FileRunRecorder({
      sessionDir,
      runId: 'run-report-diagnostics',
      strategy: 'quick',
      query: 'diagnostic query',
    });
    const secret = 'DO-NOT-PERSIST secret customer sentence without terminal punctuation';
    const validation = validateReportOutput(`# Diagnostic report

## Summary
${'A valid summary establishes enough context before the deliberately truncated final line. '.repeat(3)}
${secret}
`, { minChars: 100, mode: 'narrative' });
    const failedChecks = validation.failedChecks;
    const truncated = failedChecks.find((item) => item.check === 'report_truncated');
    assert.equal(truncated.actual.lastContentLine, undefined);
    assert.equal(truncated.actual.lastContentLength, secret.length);
    assert.match(truncated.actual.lastContentSha256, /^[a-f0-9]{64}$/);
    const error = new ReportGenerationError({
      attempts: 2,
      minChars: 100,
      outputChars: validation.outputChars,
      flags: validation.flags,
      failedChecks,
      phase: 'semantic-contract',
      attemptCounts: { provider: 0, parse: 0, semanticContract: 2, render: 0 },
    });
    assert.doesNotMatch(error.message, new RegExp(secret));
    recorder.finalize('failed', {
      error,
    });

    const failure = JSON.parse(fs.readFileSync(path.join(sessionDir, 'failure.json'), 'utf8'));
    assert.equal(failure.phase, 'semantic-contract');
    assert.ok(failure.failedChecks.every((item) => item.phase === 'semantic-contract'));
    assert.equal(failure.error.phase, 'semantic-contract');
    assert.deepEqual(failure.error.failedChecks, failure.failedChecks);
    assert.equal(failure.error.attemptCounts.semanticContract, 2);
    const run = JSON.parse(fs.readFileSync(path.join(sessionDir, 'run.json'), 'utf8'));
    assert.deepEqual(run.failedChecks, failure.failedChecks);
    assert.equal(run.phase, 'semantic-contract');
    const allArtifacts = fs.readdirSync(sessionDir, { recursive: true })
      .map((name) => path.join(sessionDir, name))
      .filter((file) => fs.statSync(file).isFile())
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    assert.doesNotMatch(allArtifacts, new RegExp(secret));
  });

  it('records the provider-normalized LLM request before dispatch and omits reasoning text', async () => {
    const sessionDir = makeSession();
    const recorder = new FileRunRecorder({
      sessionDir,
      runId: 'run-2',
      strategy: 'quick',
      query: 'record request',
    });
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret-key',
      baseUrl: 'https://llm.example/v1',
      model: 'qwen-test',
      temperature: 0.2,
      maxTokens: 4000,
      fetch: async () => ({
        ok: true,
        async json() {
          return {
            choices: [{
              message: { content: 'answer', reasoning_content: 'must not persist' },
              finish_reason: 'stop',
            }],
            usage: { total_tokens: 7, prompt_tokens: 4, completion_tokens: 3 },
          };
        },
      }),
    });
    const budget = new BudgetManager({ research: { budget: {} }, llm: { maxTokens: 4000 } });
    const wrapped = wrapProvidersWithBudget({
      llm: provider,
      search: { async search() { return []; } },
      budget,
      recorder,
    }).llm;
    assert.equal(await wrapped.complete({
      purpose: 'report',
      messages: [{ role: 'user', content: 'write report' }],
      temperature: 0.1,
      maxTokens: 0,
    }), 'answer');

    const request = JSON.parse(
      fs.readFileSync(path.join(sessionDir, 'calls', 'llm-1.request.json'), 'utf8'),
    );
    assert.equal(request.request.body.model, 'qwen-test');
    assert.equal(request.request.body.max_tokens, undefined);
    assert.equal(request.request.body.reasoning_effort, 'none');
    assert.equal(request.request.body.messages[0].content, 'write report');
    assert.ok(request.promptChars > 0);
    assert.match(request.promptSha256, /^[a-f0-9]{64}$/);
    assert.equal(request.timeoutMs, null);
    assert.ok(fs.readdirSync(path.join(sessionDir, 'checkpoints')).some((name) => (
      name.includes('report-request-ready')
    )));

    const allText = fs.readdirSync(path.join(sessionDir, 'calls'))
      .map((name) => fs.readFileSync(path.join(sessionDir, 'calls', name), 'utf8'))
      .join('\n');
    assert.doesNotMatch(allText, /secret-key/);
    assert.doesNotMatch(allText, /must not persist/);
  });

  it('records the LLM body byte-for-byte even when fetched text looks like a credential', async () => {
    const sessionDir = makeSession();
    const recorder = new FileRunRecorder({
      sessionDir,
      runId: 'run-fidelity',
      strategy: 'focused',
      query: 'fidelity',
    });
    const quotedBody = 'Source says: Authorization: Bearer abc.def.ghi and api_key=live-value';
    let sentBody;
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret-key',
      baseUrl: 'https://llm.example/v1',
      model: 'qwen-test',
      fetch: async (_url, init) => {
        sentBody = init.body;
        return {
          ok: true,
          async json() {
            return {
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
              usage: { total_tokens: 3 },
            };
          },
        };
      },
    });
    const wrapped = wrapProvidersWithBudget({
      llm: provider,
      search: { async search() { return []; } },
      budget: new BudgetManager({ research: { budget: {} }, llm: { maxTokens: 4000 } }),
      recorder,
    }).llm;
    await wrapped.complete({
      purpose: 'summarize',
      messages: [{ role: 'user', content: quotedBody }],
    });

    const request = JSON.parse(
      fs.readFileSync(path.join(sessionDir, 'calls', 'llm-1.request.json'), 'utf8'),
    );
    const sentMessages = JSON.parse(sentBody).messages;
    assert.equal(request.request.body.messages[0].content, quotedBody);
    assert.deepEqual(request.request.body.messages, sentMessages);
    assert.equal(
      request.promptSha256,
      crypto.createHash('sha256').update(JSON.stringify(sentMessages)).digest('hex'),
    );
    const runText = fs.readFileSync(path.join(sessionDir, 'run.json'), 'utf8');
    assert.doesNotMatch(runText, /secret-key/);
  });

  it('keeps the event journal small by externalizing large payloads and reading them back', () => {
    const sessionDir = makeSession();
    const recorder = new FileRunRecorder({
      sessionDir,
      runId: 'run-journal',
      strategy: 'exploratory',
      query: 'journal',
    });
    const body = 'evidence paragraph '.repeat(300);
    recorder.event('trace', { stage: 'read', body });
    recorder.event('trace', { stage: 'search', results: Array.from({ length: 4000 }, (_, index) => ({
      url: `https://example.com/${index}`,
      title: `result ${index}`,
    })) });

    const journalPath = path.join(sessionDir, 'journal', 'events.jsonl');
    const rawJournal = fs.readFileSync(journalPath, 'utf8');
    assert.doesNotMatch(rawJournal, /evidence paragraph evidence paragraph/);
    assert.equal(rawJournal.split('\n').filter((line) => line.trim()).length, 3);

    const events = readEventJournal(sessionDir, { materializeBlobs: true });
    const readEvent = events.find((event) => event.stage === 'read');
    const searchEvent = events.find((event) => event.stage === 'search');
    assert.equal(readEvent.body, body);
    assert.equal(searchEvent.results.length, 4000);
    assert.equal(searchEvent.results[3999].url, 'https://example.com/3999');
  });

  it('deduplicates large checkpoint strings into content-addressed blobs and materializes them on load', () => {
    const sessionDir = makeSession();
    const recorder = new FileRunRecorder({
      sessionDir,
      runId: 'run-large-state',
      strategy: 'exploratory',
      query: 'large state',
    });
    const content = 'repeated source body '.repeat(200);
    recorder.checkpoint('step-one', { step: 1, source: { content } });
    recorder.checkpoint('step-two', { step: 2, source: { content } });

    const textBlobs = fs.readdirSync(path.join(sessionDir, 'blobs'))
      .filter((name) => name.endsWith('.txt'));
    assert.equal(textBlobs.length, 1);
    const loaded = loadLatestCheckpoint(sessionDir);
    assert.equal(loaded.state.step, 2);
    assert.equal(loaded.state.source.content, content);
  });

  it('replays an exact recorded body against the current configured endpoint and credentials', async () => {
    const sessionDir = makeSession();
    const recorder = new FileRunRecorder({
      sessionDir,
      runId: 'run-3',
      strategy: 'quick',
      query: 'replay',
    });
    recorder.callStarted({
      callId: 'llm-9',
      kind: 'llm',
      purpose: 'report',
      request: {
        provider: 'openai-compatible',
        endpoint: 'https://old.example/v1/chat/completions',
        body: {
          model: 'model-a',
          messages: [{ role: 'user', content: 'same prompt' }],
          temperature: 0.2,
        },
      },
    });

    let observed;
    const replay = await replayRecordedLlmCall({
      sessionDir,
      callId: 'llm-9',
      settings: {
        http: {},
        llm: {
          provider: 'openai-compatible',
          baseUrl: 'https://current.example/v1',
          apiKey: 'current-secret',
        },
      },
      fetch: async (url, init) => {
        observed = { url, init };
        return {
          ok: true,
          async json() {
            return {
              choices: [{ message: { content: 'replayed' }, finish_reason: 'stop' }],
              usage: { total_tokens: 5 },
            };
          },
        };
      },
    });
    assert.equal(observed.url, 'https://current.example/v1/chat/completions');
    assert.equal(observed.init.headers.authorization, 'Bearer current-secret');
    assert.deepEqual(JSON.parse(observed.init.body), {
      model: 'model-a',
      messages: [{ role: 'user', content: 'same prompt' }],
      temperature: 0.2,
    });
    assert.equal(replay.response.text, 'replayed');
  });

  it('records content-read requests and bodies around registered fetch handlers', async () => {
    const sessionDir = makeSession();
    const recorder = new FileRunRecorder({
      sessionDir,
      runId: 'run-fetch',
      strategy: 'focused',
      query: 'read source',
    });
    registerContentFetchHandler(async (url) => ({
      status: 'ok',
      backend: 'test-reader',
      title: 'Source',
      content: `body from ${url}`,
    }));
    const findings = await enrichFindings([{
      question: 'read source',
      sources: [{ id: 'source-1', title: 'Source', url: 'https://example.com/source' }],
    }], {
      query: 'read source',
      fetchMode: 'full',
      maxUrlsPerIteration: 1,
      maxUrlsTotal: 1,
      maxContentChars: 1000,
      maxFetchChars: 1000,
      enrichConcurrency: 1,
      settings: { research: { focused: { fetchBackend: 'auto' } } },
      recorder,
    });
    assert.equal(findings[0].sources[0].fetchStatus, 'ok');
    const calls = fs.readdirSync(path.join(sessionDir, 'calls'));
    const requestName = calls.find((name) => name.startsWith('fetch-') && name.endsWith('.request.json'));
    const responseName = calls.find((name) => name.startsWith('fetch-') && name.endsWith('.response.json'));
    assert.ok(requestName);
    assert.ok(responseName);
    const request = JSON.parse(fs.readFileSync(path.join(sessionDir, 'calls', requestName), 'utf8'));
    assert.equal(request.request.viaProxy, false);
    const response = JSON.parse(fs.readFileSync(path.join(sessionDir, 'calls', responseName), 'utf8'));
    assert.match(response.response.content, /body from https:\/\/example\.com\/source/);
  });

  it('round-trips complete ResearchState, budget, query memory, maps and sets', () => {
    const budget = new BudgetManager({
      research: { exploratory: { minLlmTokens: 100 }, budget: { maxLlmTokens: 500 } },
      llm: { maxTokens: 50 },
    });
    budget.usage.llmTokens = 25;
    budget.usage.explorationTokens = 25;
    const memory = new QueryMemory({ enabled: true });
    memory.record({ query: 'alpha', gapId: 'gap-1', provider: 'test', status: 'useful', results: [] });
    memory.vectorCache.set('alpha', [0.1, 0.2]);
    const state = new ResearchState({ query: 'alpha', budget, brief: { query: 'alpha' } });
    state.step = 3;
    state.readSourceIds.add('source-1');
    state.observedHosts.add('example.com');
    state.candidates.set('source-1', { id: 'source-1', url: 'https://example.com' });
    state.urlPool.add({ id: 'source-1', url: 'https://example.com' });
    state.rerankCache.set('cache-key', { score: 0.8 });
    const checkpoint = state.exportCheckpoint({
      queryMemory: memory,
      loopLocal: { consecutiveInvalidSteps: 2 },
    });

    const restoredBudget = new BudgetManager({ research: { budget: {} }, llm: {} });
    const restoredMemory = new QueryMemory({ enabled: true });
    const restored = new ResearchState({
      query: 'alpha',
      budget: restoredBudget,
      brief: { query: 'alpha' },
    }).restoreCheckpoint(checkpoint, { queryMemory: restoredMemory });
    assert.equal(restored.step, 3);
    assert.equal(restored.readSourceIds.has('source-1'), true);
    assert.equal(restored.observedHosts.has('example.com'), true);
    assert.equal(restored.candidates.get('source-1').url, 'https://example.com');
    assert.equal(restored.urlPool.get('source-1').url, 'https://example.com');
    assert.equal(restored.rerankCache.get('cache-key').score, 0.8);
    assert.equal(restoredBudget.usage.llmTokens, 25);
    assert.equal(restoredMemory.entries[0].query, 'alpha');
    assert.deepEqual(restoredMemory.vectorCache.get('alpha'), [0.1, 0.2]);
  });

  it('keeps the pre-report checkpoint and failed report request when report transport fails', async () => {
    const sessionDir = makeSession();
    const recorder = new FileRunRecorder({
      sessionDir,
      runId: 'run-report-failure',
      strategy: 'quick',
      query: 'failure topic',
    });
    await assert.rejects(
      () => new ResearchRunner().run({
        query: 'failure topic',
        settings: {
          llm: { maxTokens: 100 },
          search: {},
          research: {
            strategy: 'quick',
            iterations: 1,
            questionsPerIteration: 1,
          },
        },
        recorder,
        search: {
          async search(query) {
            return [{ title: query, url: 'https://example.com', snippet: 'evidence' }];
          },
        },
        llm: {
          async complete({ purpose }) {
            if (purpose === 'search_query_planning') {
              return JSON.stringify({ queries: [{ query: 'follow up' }] });
            }
            throw new Error('fetch failed');
          },
        },
      }),
      /fetch failed/,
    );
    const checkpoints = fs.readdirSync(path.join(sessionDir, 'checkpoints'));
    assert.ok(checkpoints.some((name) => name.includes('strategy-complete')));
    assert.ok(checkpoints.some((name) => name.includes('pre-report')));
    const calls = fs.readdirSync(path.join(sessionDir, 'calls'));
    assert.ok(calls.includes('llm-2.request.json'));
    assert.ok(calls.includes('llm-2.error.json'));
    const reportRequest = JSON.parse(
      fs.readFileSync(path.join(sessionDir, 'calls', 'llm-2.request.json'), 'utf8'),
    );
    assert.equal(reportRequest.purpose, 'report');
    assert.match(reportRequest.request.body.messages[1].content, /Research query:/);
  });

  it('sanitizes nested secret keys while preserving replay parameters', () => {
    assert.deepEqual(sanitizeRecordedValue({
      apiKey: 'x',
      token: 'y',
      authorization: 'Bearer x',
      maxTokens: 2048,
      total_tokens: 42,
      reasoning_content: 'hidden',
      prompt: 'Authorization: Bearer abc.def.ghi OPENAI_API_KEY=super-secret https://u:p@example.com/path',
    }), {
      apiKey: '[redacted]',
      token: '[redacted]',
      authorization: '[redacted]',
      maxTokens: 2048,
      total_tokens: 42,
      prompt: 'Authorization: Bearer [redacted] OPENAI_API_KEY=[redacted] https://example.com/path',
    });
  });

  it('redacts credential query parameters carried by recorded urls', () => {
    assert.deepEqual(sanitizeRecordedValue({
      url: 'https://search.example/api?api_key=live-value&q=llm+wiki',
    }), {
      url: 'https://search.example/api?api_key=%5Bredacted%5D&q=llm+wiki',
    });
  });
});
