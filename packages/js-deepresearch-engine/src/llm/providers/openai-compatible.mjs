export class OpenAICompatibleProvider {
  constructor(config) {
    this.config = config;
    this.fetch = typeof config.fetch === 'function' ? config.fetch : globalThis.fetch;
  }

  async complete(args) {
    const result = await this.completeWithMetadata(args);
    return result.text;
  }

  async completeWithMetadata({ messages, signal, temperature, maxTokens, reasoningEffort }) {
    if (!this.config.apiKey) {
      throw new Error('API key is required for OpenAI-compatible provider.');
    }

    const baseUrl = (this.config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const response = await this.fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: temperature ?? this.config.temperature,
        max_tokens: maxTokens ?? this.config.maxTokens,
        ...((reasoningEffort || this.config.reasoningEffort || (/qwen/i.test(this.config.model || '') ? 'none' : null))
          ? { reasoning_effort: reasoningEffort || this.config.reasoningEffort || 'none' }
          : {}),
      }),
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
