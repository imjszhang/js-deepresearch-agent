import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeLiteralWikilinks, extractWikilinks, renderPage } from '../src/markdown.mjs';
import { safeObsidianFilename, wikilink, wikilinkPath } from '../src/obsidian.mjs';

describe('markdown and obsidian helpers', () => {
  it('renders YAML frontmatter pages', () => {
    const page = renderPage({
      frontmatter: { type: 'topic', title: 'LLM Wiki', tags: ['wiki'] },
      body: '# LLM Wiki',
    });
    assert.match(page, /^---\n/);
    assert.match(page, /type: topic/);
    assert.match(page, /# LLM Wiki/);
  });

  it('builds wikilinks and safe filenames', () => {
    assert.equal(wikilink('Topic', 'Alias'), '[[Topic|Alias]]');
    assert.equal(wikilinkPath('Topics/LLM Wiki.md', 'Wiki'), '[[Topics/LLM Wiki|Wiki]]');
    assert.equal(safeObsidianFilename('bad:file?name#'), 'badfilename');
  });

  it('extracts wikilinks from markdown', () => {
    const links = extractWikilinks('See [[Topics/LLM Wiki]] and [[Home|Home]]');
    assert.equal(links.length, 2);
    assert.equal(links[0].target, 'Topics/LLM Wiki');
    assert.equal(links[1].alias, 'Home');
  });

  it('ignores wikilinks inside inline code and escapes literals in content', () => {
    const escaped = escapeLiteralWikilinks('example [[页面名称]]');
    assert.match(escaped, /`\[\[页面名称\]\]`/);
    const links = extractWikilinks('Real [[Topic]] and `[[页面名称]]`');
    assert.equal(links.length, 1);
    assert.equal(links[0].target, 'Topic');
  });
});
