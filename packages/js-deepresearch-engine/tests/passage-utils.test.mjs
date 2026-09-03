import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compareRankedPassages,
  isLowValuePassage,
  isMediaOnlyPassage,
  rankingFocus,
  splitContentForPassages,
  stripPassageMarkup,
} from '../src/research/passage-utils.mjs';

describe('passage value filters', () => {
  it('only treats empty and media-only blocks as non-candidates', () => {
    assert.equal(isMediaOnlyPassage(''), true);
    assert.equal(isMediaOnlyPassage('<img src="media/image1.png" style="width:5.76806in;height:3.81843in" />'), true);
    assert.equal(isLowValuePassage('<img src="media/image1.png" />'), true);
    assert.equal(isMediaOnlyPassage('原创： yevon_ou [水库论坛](javascript:void(0);) 2017-12-11'), false);
    assert.equal(
      isMediaOnlyPassage('代持操作的核心，是产证名字和真实出资人可以分开。出资人承担房价涨跌，挂名人只出名字。'),
      false,
    );
  });

  it('keeps bylines in the candidate pool and records section metadata', () => {
    const chunks = splitContentForPassages([
      '# 代持操作手册',
      '原创： yevon_ou [水库论坛](javascript:void(0);) 2017-12-11',
      '<img src="media/image1.png" />',
      '代持操作的核心，是产证名字和真实出资人可以分开。',
    ].join('\n\n'), 1200);
    assert.equal(chunks.some((chunk) => /yevon_ou/.test(chunk.text)), true);
    assert.equal(chunks.some((chunk) => /<img/i.test(chunk.text)), false);
    assert.ok(chunks.every((chunk) => chunk.section === '代持操作手册'));
  });

  it('includes title and section in ranking focus and uses stable order on ties', () => {
    assert.match(rankingFocus({ query: '房产操作攻略', title: '1610-代持操作手册.md', section: '代持' }), /代持操作手册/);
    const ranked = [
      { text: 'later long table | a | b | c |', retrievalScore: 0, startChar: 80 },
      { text: 'earlier short note', retrievalScore: 0, startChar: 10 },
    ].sort(compareRankedPassages);
    assert.equal(ranked[0].text, 'earlier short note');
    assert.equal(stripPassageMarkup('原创： [水库论坛](javascript:void(0);)').includes('javascript'), false);
  });

  it('keeps startChar/endChar aligned after paragraph and chunk trim', () => {
    const content = [
      '# Title',
      '',
      '  Leading spaces then a filing sentence about 智谱AI revenue.',
      '',
      'Another paragraph with a trailing space.  ',
    ].join('\n');
    const chunks = splitContentForPassages(content, 24);
    assert.ok(chunks.length >= 2);
    for (const chunk of chunks) {
      assert.equal(content.slice(chunk.startChar, chunk.endChar), chunk.text);
    }
  });
});
