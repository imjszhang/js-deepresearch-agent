import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rankPassages, selectRelevantPassages } from '../src/research/passage-selector.mjs';

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

  it('returns structured scores, offsets, and ranking method', async () => {
    const embedding = {
      async embedDocuments(texts) {
        return texts.map((text) => (String(text).includes('代持') ? [1, 0] : [0, 1]));
      },
    };
    const ranked = await rankPassages({
      query: '房产操作攻略',
      title: '1610-代持操作手册.md',
      content: [
        '# 代持操作手册',
        '原创： yevon_ou 水库论坛 2017-12-11',
        '代持操作的核心，是产证名字和真实出资人可以分开。',
      ].join('\n\n'),
      embedding,
      topK: 2,
      chunkChars: 1200,
    });
    assert.equal(ranked[0].rankingMethod, 'embedding');
    assert.ok(ranked[0].retrievalScore > ranked[1].retrievalScore);
    assert.equal(typeof ranked[0].startChar, 'number');
    assert.equal(ranked[0].section, '代持操作手册');
    assert.match(ranked[0].text, /代持操作的核心/);
  });
});
