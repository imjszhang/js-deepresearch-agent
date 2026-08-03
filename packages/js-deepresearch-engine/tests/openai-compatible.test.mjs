import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { OpenAICompatibleProvider } from '../src/llm/providers/openai-compatible.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

describe('OpenAI-compatible provider', () => {
  it('disables hidden reasoning for Qwen so bounded calls return final content', async () => {
    let requestBody;
    globalThis.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'Final answer', reasoning: '' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
        }),
      };
    };
    const provider = new OpenAICompatibleProvider({ model: 'qwen3.6:27b', apiKey: 'test', baseUrl: 'https://llm.test/v1', maxTokens: 100 });
    const detailed = await provider.completeWithMetadata({ messages: [{ role: 'user', content: 'Answer' }] });
    assert.equal(requestBody.reasoning_effort, 'none');
    assert.equal(detailed.text, 'Final answer');
    assert.equal(detailed.usage.totalTokens, 7);
    assert.equal(detailed.metadata.hasReasoningContent, false);
  });

  it('detects reasoning metadata without exposing its text', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '', reasoning: 'private reasoning text' }, finish_reason: 'length' }] }),
    });
    const provider = new OpenAICompatibleProvider({ model: 'qwen', apiKey: 'test', baseUrl: 'https://llm.test/v1' });
    const detailed = await provider.completeWithMetadata({ messages: [] });
    assert.equal(detailed.text, '');
    assert.equal(detailed.metadata.hasReasoningContent, true);
    assert.equal(JSON.stringify(detailed).includes('private reasoning text'), false);
  });

  it('uses injected fetch instead of global fetch', async () => {
    let injectedCalled = false;
    const injectedFetch = async () => {
      injectedCalled = true;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'via proxy' }, finish_reason: 'stop' }],
        }),
      };
    };

    globalThis.fetch = async () => {
      throw new Error('global fetch should not be used');
    };

    const provider = new OpenAICompatibleProvider({
      model: 'test',
      apiKey: 'test',
      baseUrl: 'https://llm.test/v1',
      fetch: injectedFetch,
    });
    const detailed = await provider.completeWithMetadata({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(injectedCalled, true);
    assert.equal(detailed.text, 'via proxy');
  });
});
