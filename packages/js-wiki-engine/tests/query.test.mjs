import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askWiki } from '../src/query.mjs';
import { scoreWikiPage } from '../src/retrieval.mjs';

test('retrieval handles Chinese questions, mixed text and Unicode normalization', () => {
  assert.ok(scoreWikiPage('# 政策\n监管处罚将影响经营许可。', '监管处罚有哪些影响').score > 0);
  assert.ok(scoreWikiPage('# AI 风险\n模型监管', 'ＡＩ　监管').score > 0);
  assert.ok(scoreWikiPage('# 监管\n政策', '监管').score > 0);
  assert.ok(scoreWikiPage('# AI监管与治理', 'AI').score > 0);
  assert.match(scoreWikiPage(`${'prefix '.repeat(200)}ＡＩ监管`, 'AI').excerpt, /ＡＩ监管/);
  assert.equal(scoreWikiPage('The company paid its bill.', 'AI').score, 0);
  assert.equal(scoreWikiPage('天气影响出游。', '监管处罚有哪些影响').score, 0);
  assert.equal(scoreWikiPage('# LLM\nWiki', 'LLM LLM').score, scoreWikiPage('# LLM\nWiki', 'LLM llm').score);
});

test('retrieval excludes templates, keeps deterministic order and excerpts late hits', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdr-query-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['Topics', 'Templates', 'Lint']) fs.mkdirSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, 'Topics/a.md'), `${'preface '.repeat(200)}监管处罚影响经营许可。`);
  fs.writeFileSync(path.join(dir, 'Topics/b.md'), `${'preface '.repeat(200)}监管处罚影响经营许可。`);
  fs.writeFileSync(path.join(dir, 'Templates/t.md'), '# 监管处罚有哪些影响');
  fs.writeFileSync(path.join(dir, 'Lint/l.md'), '# 监管处罚有哪些影响');
  const result = await askWiki({ vaultDir: dir, question: '监管处罚有哪些影响' });
  assert.deepEqual(result.pages.map((p) => p.relativePath), ['Topics/a.md', 'Topics/b.md']);
  assert.match(result.pages[0].excerpt, /监管处罚/);
  assert.equal(result.mode, 'retrieval');
});
