import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextSlotRepairAction, rankSlotRepairTargets } from '../src/research/adaptive/slot-repair-scheduler.mjs';

describe('slot repair scheduler', () => {
  it('does not rank blocked gaps as repair targets', () => {
    const blocked = {
      id: 'blocked',
      requiredSlot: true,
      priority: 'critical',
      status: 'blocked',
    };
    const open = { id: 'open', question: '智谱AI估值', answerSlot: 'valuation', requiredSlot: true, status: 'open' };
    const ranked = rankSlotRepairTargets({}, [blocked, open]);
    assert.deepEqual(ranked.map((gap) => gap.id), ['open']);
    const action = nextSlotRepairAction({
      readiness: {},
      gaps: [blocked, open],
      brief: { entities: ['智谱AI'] },
      settings: {},
      evidenceScope: 'web',
      pickPolicyReads() { return []; },
      searchedQueries() { return []; },
    });
    assert.equal(action.gapId, 'open');
    assert.equal(action.action, 'search');
    assert.equal(action.needsPlanner, true);
    assert.equal(action.plannerMode, 'repair');
    assert.ok(!action.query);
  });

  it('prefers unread candidates over scheduling a planner search', () => {
    const gap = {
      id: 'gap-regulatory',
      question: '智谱AI监管合规情况',
      requiredSlot: true,
      priority: 'critical',
      status: 'open',
    };
    const action = nextSlotRepairAction({
      readiness: { unresolvedCriticalGapIds: [gap.id] },
      gaps: [gap],
      pickPolicyReads() { return [{ id: 'https://unread.test' }]; },
    }, { readiness: { unresolvedCriticalGapIds: [gap.id] } });
    assert.equal(action.action, 'read');
    assert.deepEqual(action.sourceIds, ['https://unread.test']);
  });

  it('returns a planner search request when no accepted unread source exists', () => {
    const gap = {
      id: 'gap-regulatory',
      question: '智谱AI监管合规情况',
      requiredSlot: true,
      priority: 'critical',
      status: 'open',
    };
    const action = nextSlotRepairAction({
      readiness: { unresolvedCriticalGapIds: [gap.id] },
      gaps: [gap],
      pickPolicyReads() { return []; },
    }, { readiness: { unresolvedCriticalGapIds: [gap.id] } });
    assert.equal(action.gapId, gap.id);
    assert.equal(action.action, 'search');
    assert.equal(action.needsPlanner, true);
    assert.equal(action.plannerMode, 'repair');
    assert.ok(!action.queries);
  });
});
