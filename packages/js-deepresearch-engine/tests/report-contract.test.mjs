import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildReportContract,
  buildReportPlan,
  extractQualityClaims,
  flattenPlanClaims,
  formatContractPromptBlock,
  mergeNarrativeIntoPlan,
  mergeCanonicalClaims,
  parseMarkdownNarrative,
  stripEmptyNarrativeSections,
  validateReportPlan,
  validateReportOutput,
} from '../src/index.mjs';
import { reportPrompt } from '../src/research/prompts.mjs';

const fixtureDir = path.join(import.meta.dirname, 'fixtures', 'report-pipeline', 'v20-closed-judgment');

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

describe('report contract from research state', () => {
  const brief = readJson('brief.json');
  const gaps = readJson('gaps.json');
  const findings = readJson('findings.json');
  const passages = readJson('passages.json');
  const narrative = readJson('narrative.json');

  it('treats a verified required judgment slot as closed, not blocked', () => {
    const contract = buildReportContract({
      gaps: [
        ...gaps,
        { id: 'gap-1', rollup: true, requiredSlot: true, status: 'open', question: brief.query },
        { id: 'gap-9', requiredSlot: false, status: 'blocked', question: 'A follow-up finding failed.' },
      ],
      brief,
      strategy: 'exploratory',
      stopReason: 'evidence_sufficient',
    });
    assert.equal(contract.judgmentMode, 'closed_judgment');
    assert.equal(contract.openJudgment, false);
    assert.equal(contract.requiredInKeyFindings, true);
    assert.deepEqual(contract.verifiedSlotIds, ['gap-2']);
    assert.equal(contract.unresolvedRequiredSlots.length, 0);
    assert.doesNotMatch(formatContractPromptBlock(contract), /still unresolved|only as background|remains open/i);
    assert.match(formatContractPromptBlock(contract), /verified\/supported/);
  });

  it('keeps H3 Key Findings when the H2 body is empty and counts cross-section duplicates once', () => {
    const markdown = `# Commerce Agents 判断

## Summary
${narrative.summary[0]}

## Key Findings

### 判断
- ${narrative.keyFindings[0].claims[0]}

## Confirmed Background Facts
- ${narrative.backgroundFacts[0]}
`;
    const cleaned = stripEmptyNarrativeSections(markdown);
    assert.match(cleaned, /## Key Findings/);
    assert.match(cleaned, /### 判断/);
    const parsed = parseMarkdownNarrative(cleaned);
    assert.equal(parsed.keyFindings.some((group) => group.claims.length > 0), true);
    const claims = extractQualityClaims(cleaned);
    const keyOccurrences = claims.filter((claim) => claim.kind === 'key_claim');
    assert.ok(keyOccurrences.some((claim) => (claim.placements || []).includes('summary')));
    assert.ok(keyOccurrences.some((claim) => (claim.placements || []).includes('key_findings')));
    const merged = mergeCanonicalClaims(keyOccurrences);
    assert.equal(merged.filter((claim) => claim.kind === 'key_claim').length < keyOccurrences.length, true);
  });

  it('validates the plan from research state instead of Markdown headings', () => {
    const contract = buildReportContract({ gaps, brief, strategy: 'exploratory' });
    const plan = buildReportPlan({
      contract,
      findings,
      passages,
      brief,
      gaps,
      citationMap: new Map([['1.1', { citationKey: '1.1', sourceId: 'src-official' }]]),
    });
    const merged = mergeNarrativeIntoPlan(plan, narrative);
    const check = validateReportPlan(merged, contract);
    assert.equal(check.ok, true, check.flags.join(','));
    const emptyPlan = { ...plan, keyFindings: [], slotClaims: [] };
    assert.equal(validateReportPlan(emptyPlan, contract).ok, false);
    const render = validateReportOutput(`# Title\n\n## Summary\n${narrative.summary[0]}\n`, {
      minChars: 20,
      mode: 'narrative',
      findings,
    });
    assert.equal(render.ok, true, render.flags.join(','));
  });

  it('writes closed-judgment prompts without unresolved or background-only language', () => {
    const contract = buildReportContract({ gaps, brief, strategy: 'exploratory' });
    const messages = reportPrompt({
      query: brief.query,
      findings,
      gaps,
      brief,
      contract,
      strategy: 'exploratory',
      passages,
    });
    const text = messages.map((item) => item.content).join('\n');
    assert.doesNotMatch(text, /only as Confirmed Background Facts while the judgment slot remains open/);
    assert.doesNotMatch(text, /required judgment remains unresolved/i);
    assert.match(text, /Closed judgment slots must appear in keyFindings/);
  });

  it('binds every required slot when the LLM answers only one or emits an unrelated Key Finding', () => {
    const slotFixtures = [
      {
        id: 'gap-2',
        requiredSlot: true,
        status: 'verified',
        evidenceStatus: 'verified',
        question: 'Required slot A',
        slotSupport: {
          verdict: 'supported',
          quoteAnchored: true,
          quote: 'Anchored answer for slot A.',
          supportingPassageIds: ['p-a'],
        },
      },
      {
        id: 'gap-3',
        requiredSlot: true,
        status: 'verified',
        evidenceStatus: 'verified',
        question: 'Required slot B',
        slotSupport: {
          verdict: 'supported',
          quoteAnchored: true,
          quote: 'Anchored answer for slot B.',
          supportingPassageIds: ['p-b'],
        },
      },
    ];
    const twoSlotContract = buildReportContract({
      gaps: slotFixtures,
      brief: { queryShape: 'comparison' },
      strategy: 'focused',
    });
    const twoSlotPlan = buildReportPlan({
      contract: twoSlotContract,
      gaps: slotFixtures,
      passages: [
        { id: 'p-a', sourceId: 'src-a', text: 'Anchored answer for slot A.' },
        { id: 'p-b', sourceId: 'src-b', text: 'Anchored answer for slot B.' },
      ],
      citationMap: new Map([
        ['1.1', { citationKey: '1.1', sourceId: 'src-a' }],
        ['2.1', { citationKey: '2.1', sourceId: 'src-b' }],
      ]),
    });
    assert.equal(twoSlotPlan.slotClaims.length, 2);

    for (const claims of [
      ['Anchored answer for slot A.'],
      ['An unrelated observation cannot stand in for either required slot. [1.1]'],
    ]) {
      const merged = mergeNarrativeIntoPlan(twoSlotPlan, {
        title: 'Two-slot report',
        summary: ['Both required slots must remain contract-bound in the final report.'],
        keyFindings: [{ heading: 'LLM output', claims }],
        caveats: [],
      });
      const check = validateReportPlan(merged, twoSlotContract);
      assert.equal(check.ok, true, check.flags.join(','));
      const bound = flattenPlanClaims(merged)
        .flatMap((claim) => claim.boundSlotIds || []);
      assert.ok(bound.includes('gap-2'));
      assert.ok(bound.includes('gap-3'));
    }
  });

  it('fails the semantic contract for a verified required slot without an anchored cited answer', () => {
    const unsupportedSlots = [
      {
        id: 'gap-2',
        requiredSlot: true,
        status: 'verified',
        evidenceStatus: 'verified',
        question: 'Supported slot',
        slotSupport: {
          verdict: 'supported',
          quoteAnchored: true,
          quote: 'Anchored supported answer.',
          supportingPassageIds: ['p-a'],
        },
      },
      {
        id: 'gap-3',
        requiredSlot: true,
        status: 'verified',
        evidenceStatus: 'verified',
        question: 'Unsupported frozen slot',
        slotSupport: {
          verdict: 'unverifiable',
          quoteAnchored: false,
          quote: '',
          supportingPassageIds: [],
        },
      },
    ];
    const frozenContract = buildReportContract({
      gaps: unsupportedSlots,
      brief: { queryShape: 'comparison' },
      strategy: 'focused',
    });
    const plan = buildReportPlan({
      contract: frozenContract,
      gaps: unsupportedSlots,
      passages: [{ id: 'p-a', sourceId: 'src-a', text: 'Anchored supported answer.' }],
      citationMap: new Map([['1.1', { citationKey: '1.1', sourceId: 'src-a' }]]),
    });
    const merged = mergeNarrativeIntoPlan(plan, {
      title: 'Unsupported slot report',
      summary: ['An unrelated long summary cannot make the missing required slot successful.'],
      keyFindings: [{ heading: '', claims: ['An unrelated Key Finding. [1.1]'] }],
      caveats: [],
    });
    const check = validateReportPlan(merged, frozenContract);
    assert.equal(check.ok, false);
    assert.ok(check.failedChecks.some((item) => (
      item.check === 'report_missing_required_slot_claim'
      && item.actual.slotIndex === 1
      && item.actual.boundClaims === 0
    )));
    assert.ok(merged.requiredLimitations.some((item) => item.includes('gap-3')));
  });
});
