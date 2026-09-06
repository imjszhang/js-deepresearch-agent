function resolvedMaxTokens(maxTokens, fallback) {
  if (maxTokens === 0) return undefined;
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) return Number(maxTokens);
  if (fallback === 0) return undefined;
  if (Number.isFinite(Number(fallback)) && Number(fallback) > 0) return Number(fallback);
  return undefined;
}

export class OpenAICompatibleProvider {
  constructor(config) {
    this.config = config;
    this.fetch = typeof config.fetch === 'function' ? config.fetch : globalThis.fetch;
    this.provider = 'openai-compatible';
    this.model = config.model || null;
    this.transportOptions = this.fetch?.transportOptions || null;
  }

  async complete(args) {
    const result = await this.completeWithMetadata(args);
    return result.text;
  }

  buildRecordedRequest({ messages, temperature, maxTokens, reasoningEffort } = {}) {
    const baseUrl = (this.config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    return {
      provider: this.provider,
      endpoint: `${baseUrl}/chat/completions`,
      body: {
        model: this.config.model,
        messages,
        temperature: temperature ?? this.config.temperature,
        ...(resolvedMaxTokens(maxTokens, this.config.maxTokens) === undefined
          ? {}
          : { max_tokens: resolvedMaxTokens(maxTokens, this.config.maxTokens) }),
        ...((reasoningEffort || this.config.reasoningEffort || (/qwen/i.test(this.config.model || '') ? 'none' : null))
          ? { reasoning_effort: reasoningEffort || this.config.reasoningEffort || 'none' }
          : {}),
      },
    };
  }

  async completeWithMetadata({ messages, signal, temperature, maxTokens, reasoningEffort }) {
    if (!this.config.apiKey) {
      throw new Error('API key is required for OpenAI-compatible provider.');
    }

    const request = this.buildRecordedRequest({
      messages,
      temperature,
      maxTokens,
      reasoningEffort,
    });
    const response = await this.fetch(request.endpoint, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(request.body),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${detail}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0] || {};
    const content = choice.message?.content;
    const text = Array.isArray(content)
      ? content.map((part) => typeof part === 'string' ? part : (part?.text || '')).join('')
      : String(content || '');
    return {
      text: text.trim(),
      usage: data.usage ? {
        totalTokens: data.usage.total_tokens,
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
      } : undefined,
      finishReason: choice.finish_reason || null,
      metadata: {
        responseFields: Object.keys(data),
        hasContent: Boolean(text.trim()),
        hasReasoningContent: Boolean(choice.message?.reasoning_content || choice.message?.reasoning),
      },
    };
  }
}
