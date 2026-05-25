export class OpenAICompatibleProvider {
  constructor(config) {
    this.config = config;
  }

  async complete({ messages, signal, temperature, maxTokens }) {
    if (!this.config.apiKey) {
      throw new Error('API key is required for OpenAI-compatible provider.');
    }

    const baseUrl = (this.config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/chat/completions`, {
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
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${detail}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
  }
}
