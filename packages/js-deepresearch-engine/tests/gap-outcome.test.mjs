import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveGapOutcome,
  evidenceStatusOf,
  evaluateGapEvidence,
  isRepairTerminal,
  normalizeGapRecord,
  normalizeRepairState,
} from '../src/index.mjs';

describe('gap evidence status and repair terminal', () => {
  it('migrates v4 status=blocked to repair terminal without keeping evidence blocked', () => {
    const gap = normalizeGapRecord({
      id: 'gap-2',
      schemaVersion: 4,
      requiredSlot: true,
      status: 'blocked',
      blockedReason: 'query_planner_exhausted',
      searchedQueries: ['Anthropic Commerce Agents official'],
    });
    assert.equal(gap.schemaVersion, 5);
    assert.equal(gap.evidenceStatus, 'searched');
    assert.equal(gap.status, 'searched');
    assert.equal(gap.repairState.terminal, true);
    assert.equal(gap.repairState.exhausted, true);
    assert.equal(gap.repairState.reason, 'query_planner_exhausted');
    assert.equal(gap.blockedReason, 'query_planner_exhausted');
    assert.equal(isRepairTerminal(gap), true);
    assert.equal(deriveGapOutcome(gap).repairReason, 'query_planner_exhausted');
  });

  it('keeps body_read evidence when repair is terminal', () => {
    const gap = normalizeGapRecord({
      id: 'gap-2',
      requiredSlot: true,
      status: 'body_read',
      evidenceStatus: 'body_read',
      readSourceIds: ['https://www.claude.com/blog'],
      missingEvidence: ['slot_support'],
      slotSupport: { verdict: 'unsupported', quoteAnchored: true, method: 'llm' },
      repairState: { terminal: true, exhausted: true, reason: 'query_planner_exhausted', failures: 3 },
      blockedReason: 'query_planner_exhausted',
    });
    const outcome = deriveGapOutcome(gap);
    assert.equal(outcome.evidenceStatus, 'body_read');
    assert.equal(outcome.repairTerminal, true);
    assert.equal(outcome.repairReason, 'query_planner_exhausted');
    assert.equal(gap.status, 'body_read');
    assert.equal(gap.blockedReason, gap.repairState.reason);
  });

  it('treats raw v4 blocked objects as terminal before normalize', () => {
    const raw = { id: 'blocked', requiredSlot: true, status: 'blocked' };
    assert.equal(isRepairTerminal(raw), true);
    assert.equal(normalizeRepairState(raw).terminal, true);
    assert.equal(evidenceStatusOf(raw), 'open');
  });

  it('recomputes evidence from a first-party body without clearing terminal repair', () => {
    const gap = {
      id: 'gap-2',
      requiredSlot: true,
      answerSlot: 'judgment',
      evidenceCriteria: ['first_party'],
      status: 'body_read',
      repairState: { terminal: true, exhausted: true, reason: 'query_planner_exhausted' },
      slotSupport: { verdict: 'unsupported', quoteAnchored: true, method: 'llm' },
    };
    const next = evaluateGapEvidence(gap, [{
      url: 'https://www.claude.com/blog/commerce',
      content: 'Anthropic published Commerce Agents as an official first-party blueprint for retailers.',
      fetchStatus: 'ok',
      assessment: { firstParty: true, publisherType: 'official', contentKind: 'article' },
    }]);
    assert.equal(next.evidenceStatus, 'body_read');
    assert.equal(next.status, 'body_read');
    assert.ok(next.missingEvidence.includes('slot_support'));
    assert.equal(next.repairState.terminal, true);
    assert.equal(next.blockedReason, 'query_planner_exhausted');
    assert.equal(next.blockedReason, next.repairState.reason);
  });
});
