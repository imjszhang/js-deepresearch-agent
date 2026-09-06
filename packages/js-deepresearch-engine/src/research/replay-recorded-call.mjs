import fs from 'node:fs';
import path from 'node:path';
import { createHttpFetch } from '../http/create-http-fetch.mjs';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function recordedRequestPath(sessionDir, callId) {
  const safeCallId = String(callId || '').replace(/[^a-zA-Z0-9._-]+/g, '');
  if (!safeCallId) throw new Error('A recorded call id is required.');
  const resolvedSession = path.resolve(sessionDir);
  const file = path.resolve(resolvedSession, 'calls', `${safeCallId}.request.json`);
  if (!file.startsWith(`${resolvedSession}${path.sep}`)) {
    throw new Error('Recorded call path escapes the session directory.');
  }
  return file;
}

export function loadRecordedLlmRequest({ sessionDir, callId, requestPath } = {}) {
  const file = requestPath
    ? path.resolve(requestPath)
    : recordedRequestPath(sessionDir, callId);
  const record = readJson(file);
  if (record.kind !== 'llm') {
    throw new Error(`Recorded call is not an LLM request: ${record.kind || 'unknown'}`);
  }
  if (!record.request?.body || typeof record.request.body !== 'object') {
    throw new Error('Recorded LLM request has no replayable body.');
  }
  return { file, record };
}

export function loadRecordedCallExchange({ sessionDir, callId } = {}) {
  const { file, record: request } = loadRecordedLlmRequest({ sessionDir, callId });
  const callsDir = path.dirname(file);
  const responsePath = path.join(callsDir, `${request.callId}.response.json`);
  const errorPath = path.join(callsDir, `${request.callId}.error.json`);
  const resultPath = fs.existsSync(responsePath)
    ? responsePath
    : (fs.existsSync(errorPath) ? errorPath : null);
  return {
    request,
    result: resultPath ? readJson(resultPath) : null,
    requestPath: file,
    resultPath,
  };
}

function replayEndpoint(provider, settings) {
  const baseUrl = String(settings?.llm?.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('Current LLM base URL is required for replay.');
  if (provider === 'openai-compatible') return `${baseUrl}/chat/completions`;
  if (provider === 'ollama') return `${baseUrl}/api/chat`;
  throw new Error(`Recorded LLM provider is not replayable: ${provider}`);
}

function normalizeOpenAiResponse(data = {}) {
  const choice = data.choices?.[0] || {};
  const content = choice.message?.content;
  const text = Array.isArray(content)
    ? content.map((part) => typeof part === 'string' ? part : (part?.text || '')).join('')
    : String(content || '');
  return {
    text: text.trim(),
    finishReason: choice.finish_reason || null,
    usage: data.usage || null,
    responseFields: Object.keys(data),
  };
}

function normalizeOllamaResponse(data = {}) {
  return {
    text: String(data.message?.content || '').trim(),
    finishReason: data.done_reason || null,
    usage: Number.isFinite(data.prompt_eval_count) || Number.isFinite(data.eval_count)
      ? {
        promptTokens: Number(data.prompt_eval_count || 0),
        completionTokens: Number(data.eval_count || 0),
        totalTokens: Number(data.prompt_eval_count || 0) + Number(data.eval_count || 0),
      }
      : null,
    responseFields: Object.keys(data),
  };
}

export async function replayRecordedLlmCall({
  sessionDir,
  callId,
  requestPath,
  settings,
  signal,
  fetch: providedFetch,
} = {}) {
  const { file, record } = loadRecordedLlmRequest({ sessionDir, callId, requestPath });
  const provider = record.request.provider;
  if (provider !== settings?.llm?.provider) {
    throw new Error(
      `Recorded provider "${provider}" does not match current provider "${settings?.llm?.provider || 'unknown'}".`,
    );
  }
  if (provider === 'openai-compatible' && !settings?.llm?.apiKey) {
    throw new Error('Current API key is required to replay an OpenAI-compatible LLM call.');
  }
  const endpoint = replayEndpoint(provider, settings);
  const fetch = providedFetch || createHttpFetch(settings?.http?.proxy);
  const response = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      ...(settings?.llm?.apiKey ? { authorization: `Bearer ${settings.llm.apiKey}` } : {}),
    },
    body: JSON.stringify(record.request.body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Recorded LLM replay failed (${response.status}): ${detail}`);
  }
  const data = await response.json();
  return {
    callId: record.callId,
    requestPath: file,
    provider,
    recordedEndpoint: record.request.endpoint || null,
    replayEndpoint: endpoint,
    response: provider === 'ollama'
      ? normalizeOllamaResponse(data)
      : normalizeOpenAiResponse(data),
  };
}
