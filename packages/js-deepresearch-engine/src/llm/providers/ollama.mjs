export class OllamaProvider {
  constructor(config) {
    this.config = config;
    this.fetch = typeof config.fetch === 'function' ? config.fetch : globalThis.fetch;
    this.provider = 'ollama';
    this.model = config.model || null;
    this.transportOptions = this.fetch?.transportOptions || null;
  }

  async complete(args) {
    const result = await this.completeWithMetadata(args);
    return result.text;
  }

  buildRecordedRequest({ messages, temperature } = {}) {
    const baseUrl = (this.config.baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
    return {
      provider: this.provider,
      endpoint: `${baseUrl}/api/chat`,
      body: {
        model: this.config.model,
        messages,
        stream: false,
        options: {
          temperature: temperature ?? this.config.temperature,
        },
      },
    };
  }

  async completeWithMetadata({ messages, signal, temperature }) {
    const request = this.buildRecordedRequest({ messages, temperature });
    const response = await this.fetch(request.endpoint, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify(request.body),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${detail}`);
    }

    const data = await response.json();
    return {
      text: data.message?.content?.trim() || '',
      usage: Number.isFinite(data.prompt_eval_count) || Number.isFinite(data.eval_count)
        ? { totalTokens: Number(data.prompt_eval_count || 0) + Number(data.eval_count || 0) }
        : undefined,
      finishReason: data.done_reason || null,
      metadata: { responseFields: Object.keys(data), hasContent: Boolean(data.message?.content?.trim()) },
    };
  }
}
