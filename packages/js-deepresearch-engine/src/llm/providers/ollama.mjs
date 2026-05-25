export class OllamaProvider {
  constructor(config) {
    this.config = config;
  }

  async complete({ messages, signal, temperature }) {
    const baseUrl = (this.config.baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        stream: false,
        options: {
          temperature: temperature ?? this.config.temperature,
        },
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${detail}`);
    }

    const data = await response.json();
    return data.message?.content?.trim() || '';
  }
}
