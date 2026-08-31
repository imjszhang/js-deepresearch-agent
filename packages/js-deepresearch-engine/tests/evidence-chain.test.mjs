import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  alignClaimToCitedPassages,
  buildCitationMap,
  buildEvidenceArtifacts,
  calculateQualityMetrics,
  parseCitations,
  resolveCitedSourceIds,
  stableSourceId,
} from '../src/index.mjs';

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

describe('CJK overlap against local file bodies', () => {
  it('can support a paraphrased Chinese key claim from a cited file:// body', () => {
    const localGuide = {
      title: 'guide.md',
      url: 'file:///tmp/notes/guide.md',
      snippet: '房产操作攻略目录',
      content: '房产操作攻略：先核对税费和限购，再安排首付、贷款和持有周期。这份本地指南足够长，覆盖交易顺序、资金安排、过户材料与风险提示。',
      fetchStatus: 'ok',
      contentOrigin: 'fetched',
    };
    const result = artifacts(
      '# Key Findings\n\n- 交易前应先核对税费与限购条件，再安排资金、贷款杠杆和持有周期。 [1.1]',
      [localGuide],
    );
    const claim = result.claims.find((item) => /核对税费/.test(item.text));
    assert.ok(claim);
    assert.deepEqual(claim.citationKeys, ['1.1']);
    assert.ok(claim.evidence.length > 0);
    assert.ok(['supported', 'partially_supported'].includes(claim.evaluation.verdict));
  });
});
