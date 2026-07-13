import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { selectRelevantPassages } from '../src/research/passage-selector.mjs';

const LONG_CONTENT = [
  'Ollama is a high-level tool for running local LLMs with a simple CLI and REST API.',
  'It wraps llama.cpp and focuses on easy model management for everyday users.',
  'llama.cpp is a low-level C++ inference engine optimized for CPU and GPU execution.',
  'Developers use llama.cpp when they need fine-grained control over model loading and kernels.',
].join('\n\n');

describe('passage selector', () => {
  it('returns short content without chunking', async () => {
    const result = await selectRelevantPassages({
      query: 'ollama',
      content: 'Short local LLM note.',
      shortContentChars: 600,
    });
    assert.equal(result, 'Short local LLM note.');
  });

  it('prefers llama.cpp passages for a llama.cpp-focused question via embedding', async () => {
    const embedding = {
      async embedDocuments(texts) {
        return texts.map((text) => {
          const value = String(text).toLowerCase();
          if (value.includes('llama.cpp')) return [1, 0];
          if (value.includes('ollama')) return [0.2, 0.8];
          return [0, 0];
        });
      },
    };
    const result = await selectRelevantPassages({
      query: 'llama.cpp deployment',
      question: 'How does llama.cpp work?',
      content: LONG_CONTENT,
      embedding,
      topK: 2,
      chunkChars: 120,
      windowChunks: 1,
      shortContentChars: 40,
    });
    assert.match(result, /llama\.cpp/i);
    assert.match(result, /<snippet-1>/);
  });

  it('falls back to overlap selection when embedding is unavailable', async () => {
    const result = await selectRelevantPassages({
      query: 'llama.cpp deployment',
      question: 'How does llama.cpp work?',
      content: LONG_CONTENT,
      embedding: null,
      topK: 1,
      chunkChars: 120,
      shortContentChars: 40,
    });
    assert.match(result, /llama\.cpp/i);
  });

  it('falls back to overlap when embedding throws', async () => {
    const result = await selectRelevantPassages({
      query: 'ollama local deployment',
      content: LONG_CONTENT,
      embedding: {
        async embedDocuments() {
          throw new Error('gateway down');
        },
      },
      topK: 1,
      chunkChars: 120,
      shortContentChars: 40,
    });
    assert.match(result, /ollama/i);
  });
});
