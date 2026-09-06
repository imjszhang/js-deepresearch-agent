import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ResearchState } from '../src/research/adaptive/research-state.mjs';
import { evaluateReadinessGate } from '../src/research/adaptive/readiness-gate.mjs';
import { classifyInvalidReason } from '../src/search/search-provider-error.mjs';
import {
  applySlotStatusToClaims,
  partitionFindingsForReport,
} from '../src/research/report-evidence.mjs';
import { shouldMoveWeakKeyClaim } from '../src/research/report-assembler.mjs';
import { mergeResearchBrief, sanitizeResearchBrief } from '../src/research/research-brief.mjs';

describe('zhipu contract finish-up', () => {
  it('hides rejected and pending candidates from the agent snapshot', () => {
    const state = new ResearchState({
      query: '智谱AI',
      brief: { entities: ['智谱AI'], entityAliases: ['Zhipu AI'] },
    });
    state.addCandidates([
      { id: 'ok', url: 'https://ok.test/zhipu', title: '智谱AI' },
      { id: 'bad', url: 'https://bad.test/other', title: 'Unrelated' },
      { id: 'pending', url: 'https://pending.test/zhipu', title: '智谱AI pending' },
    ], 'gap-1');
    const ok = state.candidates.get('ok');
    const bad = state.candidates.get('bad');
    const pending = state.candidates.get('pending');
    ok.gapMatches['gap-1'].relevanceDecision = { accepted: true, reasonCode: 'relevance_accepted' };
    bad.gapMatches['gap-1'].relevanceDecision = { accepted: false, reasonCode: 'entity_mismatch', matchedAlias: null };
    pending.gapMatches['gap-1'].relevanceDecision = { accepted: false, reasonCode: 'rerank_pending' };
    const agent = state.snapshotForAgent();
    assert.deepEqual(agent.unreadCandidates.map((item) => item.id), ['ok']);
    assert.equal(agent.candidateRejections.entity_mismatch, 1);
    assert.equal(agent.candidateRejections.rerank_pending, 1);
    assert.equal(state.validate({
      action: 'read',
      sourceIds: ['bad'],
      gapId: 'gap-1',
    }), 'entity_mismatch');
  });

  it('filters unread candidates against the current focus gap, not their discovery gap', () => {
    const state = new ResearchState({
      query: '智谱AI股权与产品',
      brief: { entities: ['智谱AI'] },
    });
    const product = state.addGap('产品', 'normal', { id: 'gap-product', requiredSlot: true });
    state.addGap('股权', 'critical', { id: 'gap-equity', requiredSlot: true });
    state.getGap('gap-1').status = 'verified';
    product.status = 'verified';
    state.addCandidates([
      { id: 'product-only', url: 'https://example.test/product', title: '智谱AI产品' },
    ], 'gap-product');
    const candidate = state.candidates.get('product-only');
    candidate.gapMatches['gap-product'].relevanceDecision = {
      accepted: true,
      reasonCode: 'relevance_accepted',
    };
    candidate.relevanceDecisionByGap = {
      'gap-equity': {
        accepted: false,
        reasonCode: 'entity_mismatch',
      },
    };
    const agent = state.snapshotForAgent();
    assert.equal(agent.focusGapId, 'gap-equity');
    assert.deepEqual(agent.unreadCandidates, []);
    assert.equal(agent.candidateRejections.entity_mismatch, 1);
  });

  it('returns required and repair gap ids from the readiness gate', () => {
    const gate = evaluateReadinessGate({
      profile: {
        flags: {},
        minIndependentSources: 1,
        brief: {
          requiredAnswerSlots: [
            { id: 'own', answerSlot: 'ownership' },
            { id: 'rev', answerSlot: 'revenue' },
          ],
        },
      },
      gaps: [
        {
          id: 'gap-own',
          contractSlotId: 'own',
          answerSlot: 'ownership',
          requiredSlot: true,
          priority: 'critical',
          status: 'blocked',
        },
        {
          id: 'gap-rev',
          contractSlotId: 'rev',
          answerSlot: 'revenue',
          requiredSlot: true,
          priority: 'normal',
          status: 'body_read',
        },
      ],
      findings: [{
        gapId: 'gap-rev',
        sources: [{ url: 'https://example.com/rev', content: '智谱AI revenue body with enough text.', fetchStatus: 'ok' }],
      }],
    });
    assert.deepEqual(gate.unresolvedRequiredGapIds.sort(), ['gap-own', 'gap-rev']);
    assert.ok(gate.repairGapIds.includes('gap-rev'));
    assert.ok(gate.unresolvedCriticalGapIds.includes('gap-own'));
    assert.equal(gate.pass, false);
  });

  it('classifies pre-read rejects separately from semantic repair', () => {
    assert.equal(classifyInvalidReason('entity_mismatch'), 'relevance_rejected');
    assert.equal(classifyInvalidReason('rerank_pending'), 'relevance_rejected');
    assert.equal(classifyInvalidReason('duplicate_query'), 'duplicate');
    assert.equal(classifyInvalidReason('rate_limited'), 'transient');
    assert.equal(classifyInvalidReason('no_repair_action'), 'semantic');
    assert.equal(classifyInvalidReason('repeat_action'), 'repeat');
  });

  it('attaches a cross-language follow-up to the required Commerce Agents slot', () => {
    const state = new ResearchState({
      query: '店面会话正在变成新的货架。Anthropic 开源 Commerce Agents，是在帮零售商把货架留在自己家里，还是在用「可 fork 的正确做法」把货架标准写成 Claude 的？',
      brief: { entities: ['Anthropic', 'Commerce Agents', 'Claude'] },
    });
    const required = state.addGap(
      '在店面会话正在变成新的货架的前提下,Anthropic 开源 Commerce Agents 是在帮零售商把货架留在自己家里,还是在用「可 fork 的正确做法」把货架标准写成 Claude 的?',
      'critical',
      {
        id: 'gap-2',
        requiredSlot: true,
        contractSlotId: 'judgment',
        evidenceCriteria: ['first_party'],
        deduplicate: false,
      },
    );
    const attached = state.addGap('Does the MIT license of Commerce Agents make the forkable shelf standard Claude\'s?');
    assert.equal(attached, null);
    assert.equal(state.gaps.filter((gap) => !gap.rollup && gap.id !== 'gap-1').length, 1);
    assert.ok((required.followUpQuestions || []).some((item) => /MIT license/.test(item)));
  });

  it('inherits a required slot ceiling when a follow-up finding is cited', () => {
    const claims = applySlotStatusToClaims([{
      kind: 'key_claim',
      text: 'Commerce Agents 用可 fork 蓝图把货架标准写成 Claude 的 [1.1]',
      citationKeys: ['1.1'],
      citedSourceIds: ['src-follow'],
      flags: [],
      evidence: [],
    }], {
      gaps: [
        { id: 'gap-2', requiredSlot: true, contractSlotId: 'judgment', status: 'body_read' },
        { id: 'gap-3', requiredSlot: false, parentGapId: 'gap-2', status: 'verified' },
      ],
      findings: [{
        gapId: 'gap-3',
        parentGapId: 'gap-2',
        contractSlotId: 'judgment',
        sources: [{ id: 'src-follow', content: 'Anthropic published Commerce Agents as a forkable official blueprint for retailers.', fetchStatus: 'ok' }],
      }],
    });
    assert.ok(claims[0].flags.includes('slot_limited'));
    const partitioned = partitionFindingsForReport({
      findings: [{
        gapId: 'gap-3',
        parentGapId: 'gap-2',
        contractSlotId: 'judgment',
        sources: [{ content: 'Anthropic published Commerce Agents as a forkable official blueprint for retailers.', fetchStatus: 'ok' }],
      }],
      gaps: [
        { id: 'gap-2', requiredSlot: true, contractSlotId: 'judgment', status: 'body_read' },
        { id: 'gap-3', requiredSlot: false, parentGapId: 'gap-2', status: 'verified' },
      ],
    });
    assert.equal(partitioned.limited[0].evidenceGrade, 'limited');
    assert.equal(partitioned.verified.length, 0);
  });

  it('rejects already-read URLs without counting them as semantic repair', () => {
    const state = new ResearchState({ query: 'topic' });
    state.addCandidates([{ id: 'https://claude.com/blog', url: 'https://claude.com/blog', title: 'blog' }], 'gap-1');
    const candidate = state.candidates.get('https://claude.com/blog');
    candidate.gapMatches['gap-1'].relevanceDecision = { accepted: true, reasonCode: 'relevance_accepted' };
    state.readSourceIds.add('https://claude.com/blog');
    state.lastAction = 'search';
    assert.equal(state.validate({
      action: 'read',
      sourceIds: ['https://claude.com/blog'],
      gapId: 'gap-1',
    }), 'repeat_action');
    assert.equal(classifyInvalidReason('repeat_action'), 'repeat');
  });

  it('keeps planner-exhaustion repairState after coverage sync', () => {
    const state = new ResearchState({
      query: 'Commerce Agents',
      brief: { entities: ['Commerce Agents'] },
    });
    const gap = state.addGap('judgment', 'critical', {
      id: 'gap-2',
      requiredSlot: true,
      evidenceCriteria: ['first_party'],
    });
    gap.repairFailures = 3;
    state.markGapStatus('gap-2', 'blocked', 'query_planner_exhausted');
    state.findings.push({
      gapId: 'gap-2',
      sources: [{
        id: 'https://www.claude.com/blog',
        url: 'https://www.claude.com/blog',
        content: 'Anthropic published Commerce Agents as an official first-party blueprint.',
        fetchStatus: 'ok',
        assessment: { firstParty: true, publisherType: 'official', contentKind: 'article' },
      }],
    });
    state.syncGapCoverage();
    const synced = state.getGap('gap-2');
    assert.equal(synced.repairState?.exhausted, true);
    assert.equal(synced.repairState?.terminal, true);
    assert.equal(synced.repairState?.reason, 'query_planner_exhausted');
    assert.equal(synced.blockedReason, synced.repairState.reason);
    assert.equal(synced.status, 'body_read');
    assert.equal(synced.evidenceStatus, 'body_read');
    assert.notEqual(synced.status, 'blocked');
  });

  it('keeps blocked-slot second-hand numbers out of confirmed claims', () => {
    const claims = applySlotStatusToClaims([{
      kind: 'key_claim',
      text: '控股股东持股 28%',
      citedSourceIds: ['src-media'],
      flags: [],
      evidence: [{ sourceId: 'src-media', passageId: 'p1', verdict: 'supported' }],
      evaluation: { verdict: 'supported', flags: [] },
    }], {
      gaps: [{ id: 'gap-own', requiredSlot: true, status: 'blocked' }],
      findings: [{
        gapId: 'gap-own',
        sources: [{ id: 'src-media', url: 'https://sina.test/own' }],
      }],
    });
    assert.equal(claims[0].evaluation.verdict, 'unverifiable');
    assert.ok(claims[0].flags.includes('slot_blocked'));
    assert.equal(shouldMoveWeakKeyClaim(claims[0]), true);
  });

  it('uses the cited finding slot when one source appears in blocked and verified slots', () => {
    const claims = applySlotStatusToClaims([{
      kind: 'key_claim',
      text: '股权结论 [1.1]',
      citationKeys: ['1.1'],
      citedSourceIds: ['shared-source'],
      flags: [],
      evidence: [],
    }], {
      gaps: [
        { id: 'gap-blocked', requiredSlot: true, status: 'blocked' },
        { id: 'gap-verified', requiredSlot: true, status: 'verified' },
      ],
      findings: [
        { gapId: 'gap-blocked', sources: [{ id: 'shared-source' }] },
        { gapId: 'gap-verified', sources: [{ id: 'shared-source' }] },
      ],
    });
    assert.ok(claims[0].flags.includes('slot_blocked'));
    assert.equal(claims[0].evaluation.verdict, 'unverifiable');
  });

  it('partitions findings by slot evidence grade', () => {
    const partitioned = partitionFindingsForReport({
      findings: [
        { question: 'verified slot', gapId: 'g1', sources: [{ content: 'body', fetchStatus: 'ok' }] },
        { question: 'limited slot', gapId: 'g2', sources: [{ content: 'body', fetchStatus: 'ok' }] },
        { question: 'blocked slot', gapId: 'g3', sources: [{ snippet: '28%' }] },
      ],
      gaps: [
        { id: 'g1', requiredSlot: true, status: 'verified' },
        { id: 'g2', requiredSlot: true, status: 'limited' },
        { id: 'g3', requiredSlot: true, status: 'blocked' },
      ],
    });
    assert.equal(partitioned.verified[0].evidenceGrade, 'verified');
    assert.equal(partitioned.limited[0].evidenceGrade, 'limited');
    assert.equal(partitioned.blocked[0].evidenceGrade, 'blocked');
  });

  it('lets user structured aliases and asOf win over the planner', () => {
    const merged = mergeResearchBrief({
      query: '智谱AI',
      entities: ['智谱AI'],
      entityAliases: ['用户别名'],
      asOf: '2026-08',
    }, {
      entities: ['Planner'],
      entityAliases: ['planner'],
      asOf: '2025-01',
    });
    assert.deepEqual(merged.entityAliases, ['用户别名']);
    assert.equal(merged.asOf.date, '2026-08-31');
    assert.equal(sanitizeResearchBrief({ query: 'q', asOf: { date: '2024-12-15', source: 'user', label: 'old' } }).asOf.date, '2024-12-15');
  });
});
