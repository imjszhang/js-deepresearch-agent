import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildResearchLimitations, slotEvidenceLimitations } from '../src/index.mjs';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';

function judgmentGap(overrides = {}) {
  return {
    id: 'gap-2',
    requiredSlot: true,
    answerSlot: 'judgment',
    evidenceCriteria: ['first_party'],
    evidenceStatus: 'body_read',
    status: 'body_read',
    slotSupport: { verdict: 'unsupported', quoteAnchored: true, method: 'llm' },
    missingEvidence: ['slot_support'],
    repairState: { terminal: true, exhausted: true, reason: 'query_planner_exhausted' },
    blockedReason: 'query_planner_exhausted',
    ...overrides,
  };
}

describe('canonical research limitations', () => {
  it('uses the first-party-read-but-unsupported template instead of filing or media paraphrase', () => {
    const built = buildResearchLimitations({
      gaps: [judgmentGap()],
      stopDetail: 'query_planner_exhausted',
      strategy: 'exploratory',
    });
    const text = built.limitations.join('\n');
    assert.match(text, /first-party bodies were read but they are not sufficient to support the required judgment/i);
    assert.doesNotMatch(text, /media paraphrase/i);
    assert.doesNotMatch(text, /first-party filing/i);
    assert.doesNotMatch(text, /no first-party or official source was successfully read/i);
    assert.match(text, /query_planner_exhausted/);
    assert.ok(built.limitationKeys.includes('slot:gap-2:slot_support'));
    assert.ok(built.limitationKeys.includes('repair:gap-2:query_planner_exhausted'));
  });

  it('emits criterion-specific templates and filing only when filing is actually missing', () => {
    const built = buildResearchLimitations({
      gaps: [judgmentGap({
        evidenceCriteria: ['first_party', 'filing', 'numeric', 'user_named', 'mainstream_media'],
        requiredHosts: ['www.claude.com'],
        missingEvidence: [
          'criterion:first_party',
          'criterion:filing',
          'criterion:numeric',
          'criterion:user_named',
          'criterion:mainstream_media',
          'primary_filing',
          'slot_support',
        ],
      })],
    });
    const text = built.limitations.join('\n');
    assert.match(text, /no first-party or official source was successfully read/i);
    assert.match(text, /no filing or primary disclosure/i);
    assert.match(text, /no citable numeric evidence/i);
    assert.match(text, /user-named host/i);
    assert.match(text, /mainstream media corroboration/i);
    assert.equal(text.split('no filing or primary disclosure').length - 1, 1);
  });

  it('deduplicates moved claims and extra text by stable keys', () => {
    const built = buildResearchLimitations({
      gaps: [judgmentGap()],
      movedClaims: [
        'Retailers keep the shelf. [1.1]',
        'Retailers keep the shelf. [1.1]',
      ],
      extra: [
        'The report cannot support: judgment remains open.',
        'The report cannot support: judgment remains open.',
      ],
    });
    assert.equal(built.limitations.filter((item) => item.includes('Insufficient direct evidence for: Retailers keep the shelf')).length, 1);
    assert.equal(built.limitations.filter((item) => item.includes('judgment remains open')).length, 1);
  });

  it('lists circuit hosts, unmet required hosts, and reprint-only evidence', () => {
    const built = buildResearchLimitations({
      strategy: 'focused',
      reprintOnly: true,
      blockedHosts: [{ hostname: 'walled.test', reason: 'http_403' }],
      unmetRequiredHosts: [
        { host: 'official.test', reason: 'fetch_blocked' },
        { host: 'ok.test', reason: 'body_rejected' },
      ],
    });
    const text = built.limitations.join('\n');
    assert.match(text, /Circuit is open for walled.test/);
    assert.match(text, /Required host official.test was not retrieved \(fetch_blocked\)/);
    assert.match(text, /Required host ok.test was retrieved but the body was rejected as evidence/);
    assert.match(text, /reprint sources/);
  });

  it('does not list a globally read required host as unread or blocked', () => {
    const state = new ResearchState({ query: 'qwen3.8:27b huggingface.co github.com qwenlm.github.io' });
    state.gaps = [{
      id: 'gap-2',
      question: 'hardware requirements',
      status: 'open',
      requiredSlot: true,
      requiredHosts: ['github.com', 'qwenlm.github.io'],
    }];
    state.findings = [{
      gapId: 'gap-2',
      sources: [{
        url: 'https://github.com/QwenLM/Qwen3.8/discussions',
        content: 'A successful GitHub discussion body long enough to count as evidence.',
        fetchStatus: 'ok',
      }],
    }];
    const notes = state.unresolvedReportNotes();
    assert.deepEqual(notes.unresolvedRequiredHostCommitments, ['github.com', 'qwenlm.github.io']);
    assert.deepEqual(notes.blockedHosts, ['qwenlm.github.io']);
    const built = buildResearchLimitations({
      gaps: state.gaps,
      strategy: 'exploratory',
      unmetRequiredHosts: [
        { host: 'qwenlm.github.io', reason: 'not_retrieved' },
      ],
    });
    const text = built.limitations.join('\n');
    assert.match(text, /Required host qwenlm.github.io was not retrieved \(not_retrieved\)/);
    assert.doesNotMatch(text, /Blocked or unread required hosts/);
    assert.doesNotMatch(text, /Required host github.com was not retrieved/);
  });

  it('keeps slotEvidenceLimitations as a thin slot/repair wrapper', () => {
    const texts = slotEvidenceLimitations([judgmentGap()]);
    assert.ok(texts.some((item) => /first-party bodies were read/i.test(item)));
    assert.ok(texts.some((item) => /query_planner_exhausted/.test(item)));
    assert.equal(texts.some((item) => /budget was exhausted/.test(item)), false);
  });
});
