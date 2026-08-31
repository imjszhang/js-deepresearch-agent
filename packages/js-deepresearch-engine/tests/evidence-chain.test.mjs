import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  alignClaimToCitedPassages,
  alignReportClaims,
  buildCitationMap,
  buildEvidenceArtifacts,
  buildPassageArtifacts,
  calculateQualityMetrics,
  parseCitations,
  resolveCitedSourceIds,
  selectDisplayedEvidence,
  stableSourceId,
  buildPassageArtifactsAsync,
} from '../src/index.mjs';
import { compareRankedPassages, isMediaOnlyPassage } from '../src/research/passage-utils.mjs';

const wikipedia = {
  title: 'Ollama',
  url: 'https://en.wikipedia.org/wiki/Ollama',
  snippet: 'Security risks exist in local model execution when loading untrusted models.',
};
const official = {
  title: 'Ollama official site',
  url: 'https://ollama.com',
  snippet: 'Run large language models locally.',
  content: 'Security risks exist in local model execution when loading untrusted models. Official documentation discusses sandboxing and trusted weights.',
  fetchStatus: 'ok',
  contentOrigin: 'fetched',
};
const secondary = {
  title: 'Secondary writeup',
  url: 'https://blog.example.test/ollama',
  snippet: 'Community notes',
  content: 'The official site documents local and cloud deployment options for developer teams.',
  fetchStatus: 'ok',
  contentOrigin: 'fetched',
};

function artifacts(report, sources, options = {}) {
  return buildEvidenceArtifacts({
    query: 'What is Ollama?',
    findings: [{ question: 'What is Ollama?', sources }],
    report,
    options: { claimAlignment: true, strategy: 'exploratory', ...options },
  });
}

describe('citation parsing and resolution', () => {
  it('parses [1.1] and resolves it to the expected sourceId', () => {
    const sources = [{ ...wikipedia }, { ...official }];
    const map = buildCitationMap([{ question: 'security', sources }], { sourceIdFor: stableSourceId });
    const keys = parseCitations('Security risks exist [1.1]');
    assert.deepEqual(keys, ['1.1']);
    const resolved = resolveCitedSourceIds(keys, map);
    assert.deepEqual(resolved.unresolvedCitationKeys, []);
    assert.deepEqual(resolved.citedSourceIds, [stableSourceId(wikipedia)]);
  });

  it('parses multi-cite blocks such as [1.2, 2.3]', () => {
    assert.deepEqual(parseCitations('Both vendors document the same API [1.2, 2.3].'), ['1.2', '2.3']);
  });
});

describe('citation-constrained claim alignment', () => {
  it('aligns adapter URL ids to the same stable sourceId as passages', () => {
    const hostinger = {
      id: 'https://www.hostinger.com/tutorials/what-is-ollama/',
      title: 'What is Ollama?',
      url: 'https://www.hostinger.com/tutorials/what-is-ollama/',
      snippet: 'Run models locally.',
      content: 'Ollama is a free, open-source platform designed to run large language models (LLMs) locally on user hardware.',
      fetchStatus: 'ok',
      contentOrigin: 'fetched',
    };
    const result = artifacts(
      '# Summary\n\nOllama is a free, open-source platform designed to run large language models (LLMs) locally on user hardware [1.1].',
      [hostinger],
    );
    const claim = result.claims[0];
    const expectedId = stableSourceId(hostinger);
    assert.equal(result.sources[0].id, expectedId);
    assert.ok(result.passages.every((passage) => passage.sourceId === expectedId));
    assert.deepEqual(claim.citationKeys, ['1.1']);
    assert.deepEqual(claim.citedSourceIds, [expectedId]);
    assert.equal(claim.flags.includes('missing_direct_evidence'), false);
    assert.ok(claim.evidence.length > 0);
    assert.ok(claim.evidence.every((entry) => entry.sourceId === expectedId));
    assert.equal(claim.evaluation.verdict, 'supported');
  });

  it('emits evidence only from cited sourceIds', () => {
    const result = artifacts(
      '# Summary\n\nOfficial documentation discusses sandboxing and trusted weights [1.2].',
      [{ ...wikipedia }, { ...official }],
    );
    const claim = result.claims[0];
    assert.deepEqual(claim.citationKeys, ['1.2']);
    assert.deepEqual(claim.citedSourceIds, [stableSourceId(official)]);
    assert.ok(claim.evidence.length > 0);
    assert.ok(claim.evidence.every((entry) => entry.sourceId === stableSourceId(official)));
    assert.equal(claim.evaluation.verdict, 'supported');
  });

  it('restricts multi-cite claims to that source set', () => {
    const result = artifacts(
      '# Evidence\n\nLocal and cloud deployment options are documented for developer teams [1.1, 1.2].',
      [{ ...official }, { ...secondary }, {
        title: 'Unrelated',
        url: 'https://unrelated.example',
        content: 'Local and cloud deployment options are documented for developer teams in unrelated marketing copy.',
        fetchStatus: 'ok',
        contentOrigin: 'fetched',
      }],
    );
    const claim = result.claims[0];
    assert.deepEqual(claim.citationKeys, ['1.1', '1.2']);
    const allowed = new Set([stableSourceId(official), stableSourceId(secondary)]);
    assert.ok(claim.evidence.every((entry) => allowed.has(entry.sourceId)));
    assert.equal(claim.evidence.some((entry) => entry.sourceId === stableSourceId({ url: 'https://unrelated.example' })), false);
  });

  it('flags unresolved citations and refuses supported', () => {
    const result = artifacts(
      '# Summary\n\nSecurity risks exist [9.9].',
      [{ ...official }],
    );
    const claim = result.claims[0];
    assert.ok(claim.flags.includes('unresolved_citation'));
    assert.deepEqual(claim.unresolvedCitationKeys, ['9.9']);
    assert.equal(claim.evidence.length, 0);
    assert.notEqual(claim.evaluation.verdict, 'supported');
    assert.equal(claim.evaluation.verdict, 'unverifiable');
  });

  it('flags missing body on the cited source and does not borrow another source', () => {
    const result = artifacts(
      '# Summary\n\nSecurity risks exist in local model execution when loading untrusted models [1.1].',
      [{ ...wikipedia }, { ...official }],
    );
    const claim = result.claims[0];
    assert.ok(claim.flags.includes('missing_direct_evidence'));
    assert.equal(claim.evidence.length, 0);
    assert.equal(claim.evaluation.verdict, 'unverifiable');
    assert.equal(claim.evidence.some((entry) => entry.sourceId === stableSourceId(official)), false);
  });

  it('does not align a Wikipedia citation to official-site wording when Wikipedia has no passage', () => {
    const result = artifacts(
      '# Key Findings\n\nSecurity risks exist in local model execution when loading untrusted models [1.1].',
      [{ ...wikipedia }, { ...official }],
      { strategy: 'focused' },
    );
    const claim = result.claims.find((item) => /Security risks exist/.test(item.text));
    assert.ok(claim);
    assert.deepEqual(claim.citationKeys, ['1.1']);
    assert.deepEqual(claim.citedSourceIds, [stableSourceId(wikipedia)]);
    assert.ok(claim.flags.includes('missing_direct_evidence'));
    assert.ok(claim.flags.includes('snippet_only'));
    assert.equal(claim.evidence.length, 0);
    assert.notEqual(claim.evaluation.verdict, 'supported');
    assert.notEqual(claim.evaluation.verdict, 'partially_supported');
    assert.equal(
      alignClaimToCitedPassages(claim, {
        passages: result.passages,
        citationMap: result.citationMap,
        strategy: 'focused',
      }).evidence.some((entry) => entry.sourceId === stableSourceId(official)),
      false,
    );
  });

  it('may use another cited source body when one citation is snippet-only', () => {
    const result = artifacts(
      '# Summary\n\nOfficial documentation discusses sandboxing and trusted weights [1.1, 1.2].',
      [{ ...wikipedia }, { ...official }],
    );
    const claim = result.claims[0];
    assert.ok(claim.flags.includes('missing_direct_evidence'));
    assert.ok(claim.evidence.every((entry) => entry.sourceId === stableSourceId(official)));
    assert.equal(claim.evaluation.verdict, 'supported');
  });

  it('marks uncited claims as unverifiable without using other sources', () => {
    const result = artifacts(
      '# Summary\n\nSecurity risks exist in local model execution when loading untrusted models.',
      [{ ...official }],
    );
    const claim = result.claims[0];
    assert.ok(claim.flags.includes('uncited'));
    assert.equal(claim.evidenceConstraint, 'uncited');
    assert.equal(claim.evidence.length, 0);
    assert.equal(claim.evaluation.verdict, 'unverifiable');
  });
});

describe('snippet-only and strategy policy', () => {
  it('cannot support focused/exploratory key claims from a snippet alone', () => {
    for (const strategy of ['focused', 'exploratory']) {
      const result = artifacts(
        '# Summary\n\nSecurity risks exist in local model execution when loading untrusted models [1.1].',
        [{ ...wikipedia }],
        { strategy },
      );
      const claim = result.claims[0];
      assert.ok(claim.flags.includes('snippet_only'));
      assert.ok(claim.flags.includes('missing_direct_evidence'));
      assert.notEqual(claim.evaluation.verdict, 'supported');
      const metrics = calculateQualityMetrics(result.claims);
      assert.equal(metrics.claims.supported, 0);
    }
  });

  it('keeps quick snippet-compatible with directEvidenceRate 0', () => {
    const result = artifacts(
      '# Summary\n\nSecurity risks exist in local model execution when loading untrusted models [1.1].',
      [{ ...wikipedia }],
      { strategy: 'quick' },
    );
    const metrics = calculateQualityMetrics(result.claims);
    assert.equal(result.passages.length, 0);
    assert.equal(metrics.rates.directEvidenceRate, 0);
    assert.ok(result.claims.length > 0);
    assert.notEqual(result.claims[0].evaluation.verdict, 'supported');
  });
});

describe('passage artifacts and report claim alignment', () => {
  function stripObservedAt(passages = []) {
    return passages.map((passage) => {
      const rest = { ...passage };
      delete rest.observedAt;
      return rest;
    });
  }

  it('keeps wrapper results equivalent to the split helpers', () => {
    const report = '# Summary\n\nOfficial documentation discusses sandboxing and trusted weights [1.2].';
    const sources = [{ ...wikipedia }, { ...official }];
    const options = { claimAlignment: true, strategy: 'exploratory', maxPassagesPerSource: 5, maxPassageChars: 1200 };
    const findings = [{ question: 'What is Ollama?', sources }];
    const wrapped = buildEvidenceArtifacts({ query: 'What is Ollama?', findings, report, options });
    const split = buildPassageArtifacts({ query: 'What is Ollama?', findings, options });
    const claims = alignReportClaims({
      report,
      passages: split.passages,
      citationMap: split.citationMap,
      options,
    });
    assert.deepEqual(split.sources.map((source) => source.id), wrapped.sources.map((source) => source.id));
    assert.deepEqual(stripObservedAt(split.passages), stripObservedAt(wrapped.passages));
    assert.deepEqual(claims.map((claim) => claim.id), wrapped.claims.map((claim) => claim.id));
    assert.deepEqual(claims[0].citedSourceIds, wrapped.claims[0].citedSourceIds);
  });

  it('caps stored passages and displayed evidence independently', () => {
    const paragraph = 'Local-first AI keeps user data on devices and synchronizes selectively. ';
    const content = `${paragraph.repeat(8)}\n\n${'Offline access remains available after the first sync window closes. '.repeat(8)}`;
    const source = {
      title: 'Primary',
      url: 'https://example.com/a',
      content,
      fetchStatus: 'ok',
      contentOrigin: 'fetched',
    };
    const split = buildPassageArtifacts({
      query: 'What is local-first AI?',
      findings: [{ question: 'What is local-first AI?', sources: [source] }],
      options: { maxPassagesPerSource: 2, maxPassageChars: 80 },
    });
    assert.ok(split.passages.length <= 2);
    assert.ok(split.passages.every((passage) => passage.text.length <= 80));
    const displayed = selectDisplayedEvidence(source, { passages: split.passages, maxChars: 80 });
    assert.ok(displayed.length <= 80);
    assert.equal(displayed, split.passages.slice().sort(compareRankedPassages)[0].text);
    const reassembled = buildPassageArtifacts({
      query: 'What is local-first AI?',
      findings: split.findings,
      options: { maxPassagesPerSource: 2, maxPassageChars: 80 },
    });
    assert.deepEqual(reassembled.sources.map((item) => item.id), split.sources.map((item) => item.id));
    assert.equal(reassembled.passages.length, split.passages.length);
  });

  it('keeps bylines as candidates but displays the semantically preferred body', async () => {
    const content = [
      '# ​代持操作手册 #1610',
      '原创： yevon_ou [水库论坛](javascript:void(0);) 2017-12-11',
      '<img src="media/image1.png" style="width:5.76806in;height:3.81843in" />',
      '代持操作的核心，是产证名字和真实出资人可以分开。出资人承担房价涨跌，挂名人只出名字。',
      '国务院是不可以规定“公民不许买房子”的。但是他可以管自己的下属，可以管行政机构。',
    ].join('\n\n');
    const source = {
      title: '1610-代持操作手册.md',
      url: 'file:///corpus/1610.md',
      content,
      fetchStatus: 'ok',
      contentOrigin: 'fetched',
    };
    const artifacts = await buildPassageArtifactsAsync({
      query: '房产操作攻略',
      findings: [{ question: '房产操作攻略', sources: [source] }],
      options: {
        maxPassagesPerSource: 5,
        maxPassageChars: 1200,
        embedding: {
          async embedDocuments(texts) {
            return texts.map((text) => {
              const value = String(text);
              if (value.includes('代持操作手册') || value.includes('代持操作的核心')) return [1, 0];
              return [0, 1];
            });
          },
        },
      },
    });
    assert.ok(artifacts.passages.some((passage) => /yevon_ou/.test(passage.text)));
    assert.ok(artifacts.passages.every((passage) => !isMediaOnlyPassage(passage.text)));
    assert.ok(artifacts.passages.every((passage) => !/<img/i.test(passage.text)));
    assert.ok(artifacts.passages.every((passage) => passage.rankingMethod === 'embedding'));
    const displayed = selectDisplayedEvidence(source, { passages: artifacts.passages });
    assert.match(displayed, /代持操作的核心/);
    assert.doesNotMatch(displayed, /yevon_ou|2017-12-11/);
  });

  it('lets a relevant table beat an unrelated footnote when embeddings prefer it', async () => {
    const content = [
      '原创： yevon_ou 水库论坛 2017-12-11',
      '| 租给中国人 | 8000 | 9000 | 10000 |',
      '| 外国人 | 28000 | 28000 | 28000 |',
      '[1] https://www.zhihu.com/question/52444153/answer/130645934',
    ].join('\n\n');
    const source = {
      title: '0380-外国人购房手册.md',
      url: 'file:///corpus/0380.md',
      content,
      fetchStatus: 'ok',
      contentOrigin: 'fetched',
    };
    const embedding = {
      async embedDocuments(texts) {
        return texts.map((text) => {
          const value = String(text);
          if (value.includes('外国人购房') || value.includes('租给中国人')) return [1, 0];
          if (value.includes('zhihu.com')) return [0, 1];
          return [0.1, 0.1];
        });
      },
    };
    const artifacts = await buildPassageArtifactsAsync({
      query: '外国人房租怎么比较',
      findings: [{ question: '外国人购房手册里的租金差价是多少？', sources: [source] }],
      options: { maxPassagesPerSource: 2, maxPassageChars: 1200, embedding },
    });
    assert.ok(artifacts.passages.every((passage) => passage.rankingMethod === 'embedding'));
    const displayed = selectDisplayedEvidence(source, { passages: artifacts.passages });
    assert.match(displayed, /租给中国人|28000/);
    assert.doesNotMatch(displayed, /zhihu\.com|yevon_ou/);
  });

  it('falls back to overlap ranking when embedding throws', async () => {
    const source = {
      title: '1610-代持操作手册.md',
      url: 'file:///corpus/1610.md',
      content: [
        '亚瑟王是Celts凯尔特人，5世纪古罗马帝国崩溃之后，日耳曼大移民。',
        'The nominee holding arrangement separates the title from the true investor.',
      ].join('\n\n'),
      fetchStatus: 'ok',
      contentOrigin: 'fetched',
    };
    const artifacts = await buildPassageArtifactsAsync({
      query: 'nominee holding',
      findings: [{ question: 'nominee holding', sources: [source] }],
      options: {
        maxPassagesPerSource: 1,
        maxPassageChars: 1200,
        embedding: {
          async embedDocuments() {
            throw new Error('gateway down');
          },
        },
      },
    });
    assert.equal(artifacts.passages[0].rankingMethod, 'overlap');
    assert.match(selectDisplayedEvidence(source, { passages: artifacts.passages }), /nominee holding/);
  });
});
