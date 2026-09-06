import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applySlotStatusToClaims,
  assembleReport,
  buildReportContract,
  buildResearchLimitations,
  calculateQualityMetrics,
  claimHasIndependentFirstPartyEvidence,
  extractQualityClaims,
  hasOpenJudgmentSlot,
  partitionFindingsForReport,
  ResearchRunner,
  reviseUnsupportedKeyClaims,
  shouldMoveWeakPremiseFact,
  stripEmptyNarrativeSections,
  validateReportOutput,
  validateReportPlan,
} from '../src/index.mjs';
import { alignClaimToCitedPassages } from '../src/research/evidence-chain.mjs';
import { defaultSearchQueryPlan } from './helpers/search-query-planner-mock.mjs';

const FIRST_PARTY_BODY = 'Anthropic published Commerce Agents as an open-source blueprint. Retailers can fork the reference implementation and keep checkout on their own site.';

const officialFinding = {
  question: 'What does Anthropic say Commerce Agents is?',
  gapId: 'gap-2',
  contractSlotId: 'judgment',
  answerSlot: 'judgment',
  sources: [{
    id: 'src-official',
    title: 'Commerce Agents',
    url: 'https://www.claude.com/blog/commerce-agents',
    content: FIRST_PARTY_BODY,
    summary: FIRST_PARTY_BODY,
    fetchStatus: 'ok',
    contentOrigin: 'fetched',
    assessment: { firstParty: true, publisherType: 'official', contentKind: 'article' },
  }],
};

const judgmentGaps = [{
  id: 'gap-2',
  requiredSlot: true,
  contractSlotId: 'judgment',
  answerSlot: 'judgment',
  evidenceCriteria: ['first_party'],
  evidenceStatus: 'body_read',
  status: 'body_read',
  slotSupport: { verdict: 'unsupported', quoteAnchored: true, method: 'llm' },
  missingEvidence: ['slot_support'],
  repairState: { terminal: true, exhausted: true, reason: 'query_planner_exhausted' },
  blockedReason: 'query_planner_exhausted',
}];

const longBackground = 'Anthropic describes Commerce Agents as an open-source blueprint that retailers can fork while keeping checkout on their own site. [1.1]';
const longSummary = 'The required judgment remains unresolved: first-party bodies were read, but they do not prove that retailers keep the shelf or that Claude locks the standard. [1.1]';

describe('confirmed background facts', () => {
  it('partitions first-party bodies into backgroundVerified while the judgment slot stays limited', () => {
    const partitioned = partitionFindingsForReport({
      findings: [officialFinding],
      gaps: judgmentGaps,
      strategy: 'exploratory',
      brief: { queryShape: 'judgment' },
    });
    assert.equal(partitioned.limited[0].evidenceGrade, 'limited');
    assert.equal(partitioned.backgroundVerified.length, 1);
    assert.equal(hasOpenJudgmentSlot(judgmentGaps, { queryShape: 'judgment' }), true);
  });

  it('exempts supported first-party premise facts and ceilings judgment key claims', () => {
    const findings = [officialFinding];
    const premise = applySlotStatusToClaims([{
      kind: 'premise_fact',
      text: longBackground,
      citationKeys: ['1.1'],
      citedSourceIds: ['src-official'],
      flags: [],
      evidence: [{ sourceId: 'src-official', passageId: 'p1', verdict: 'supported' }],
      evaluation: { verdict: 'supported', flags: [] },
    }], { gaps: judgmentGaps, findings });
    const judgment = applySlotStatusToClaims([{
      kind: 'key_claim',
      text: 'Retailers therefore keep the shelf. [1.1]',
      citationKeys: ['1.1'],
      citedSourceIds: ['src-official'],
      flags: [],
      evaluation: { verdict: 'supported', flags: [] },
    }], { gaps: judgmentGaps, findings });
    assert.ok(premise[0].flags.includes('slot_premise_exempt'));
    assert.deepEqual(premise[0].boundSlotIds, ['gap-2']);
    assert.equal(shouldMoveWeakPremiseFact(premise[0]), false);
    assert.ok(judgment[0].flags.includes('slot_limited') || judgment[0].flags.includes('slot_blocked'));
    assert.equal(claimHasIndependentFirstPartyEvidence(premise[0], findings), true);
  });

  it('keeps an LLM-classified source-attributed fact without letting it close the judgment slot', () => {
    const [fact] = applySlotStatusToClaims([{
      kind: 'key_claim',
      claimRole: 'source_attributed_fact',
      text: 'Anthropic describes Commerce Agents as an open-source blueprint. [1.1]',
      citationKeys: ['1.1'],
      citedSourceIds: ['src-official'],
      evidence: [{
        sourceId: 'src-official',
        passageId: 'p1',
        verdict: 'supported',
        method: 'llm',
      }],
      flags: [],
      evaluation: { verdict: 'supported', flags: [] },
    }], { gaps: judgmentGaps, findings: [officialFinding] });
    assert.ok(fact.flags.includes('slot_fact_exempt'));
    assert.equal(fact.evaluation.verdict, 'supported');
    assert.deepEqual(fact.boundSlotIds, ['gap-2']);
    assert.equal(judgmentGaps[0].evidenceStatus, 'body_read');
    assert.equal(judgmentGaps[0].slotSupport.verdict, 'unsupported');
  });

  it('does not exempt a research judgment even when a cited first-party passage supports part of it', () => {
    const [judgment] = applySlotStatusToClaims([{
      kind: 'key_claim',
      claimRole: 'research_judgment',
      text: 'Retailers therefore keep the shelf. [1.1]',
      citationKeys: ['1.1'],
      citedSourceIds: ['src-official'],
      evidence: [{ sourceId: 'src-official', passageId: 'p1', verdict: 'supported', method: 'llm' }],
      flags: [],
      evaluation: { verdict: 'supported', flags: [] },
    }], { gaps: judgmentGaps, findings: [officialFinding] });
    assert.ok(judgment.flags.includes('slot_limited') || judgment.flags.includes('slot_blocked'));
    assert.ok(!judgment.flags.includes('slot_fact_exempt'));
  });

  it('does not create a background-fact exemption outside an open judgment context', () => {
    const nonJudgmentGaps = [{
      ...judgmentGaps[0],
      contractSlotId: 'architecture',
      answerSlot: 'architecture',
    }];
    const [claim] = applySlotStatusToClaims([{
      kind: 'key_claim',
      claimRole: 'source_attributed_fact',
      text: 'Anthropic describes Commerce Agents as an open-source blueprint. [1.1]',
      citationKeys: ['1.1'],
      citedSourceIds: ['src-official'],
      evidence: [{ sourceId: 'src-official', passageId: 'p1', verdict: 'supported', method: 'llm' }],
      flags: [],
      evaluation: { verdict: 'supported', flags: [] },
    }], { gaps: nonJudgmentGaps, findings: [officialFinding], brief: { queryShape: 'fact' } });
    assert.ok(claim.flags.includes('slot_limited') || claim.flags.includes('slot_blocked'));
    assert.ok(!claim.flags.includes('slot_fact_exempt'));
  });

  it('relocates an exempt source-attributed key claim into Background Facts without raising the primary support rate', () => {
    const factText = 'Anthropic describes Commerce Agents as an open-source blueprint. [1.1]';
    const revised = reviseUnsupportedKeyClaims(`# Research Report

## Summary
The required judgment remains unresolved after reviewing first-party bodies, so no strategic conclusion is presented as established. [1.1]

## Key Findings
- ${factText}
`, [{
      kind: 'key_claim',
      section: 'Key Findings',
      text: factText,
      claimRole: 'source_attributed_fact',
      flags: ['slot_fact_exempt'],
      evaluation: { verdict: 'supported', flags: ['slot_fact_exempt'] },
    }]);
    assert.equal(revised.changed, true);
    assert.deepEqual(revised.relocated, [factText]);
    assert.match(revised.report, /## Confirmed Background Facts/);
    assert.match(revised.report, new RegExp(factText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(revised.report, /## Key Findings/);
    const claims = extractQualityClaims(revised.report).map((claim) => ({
      ...claim,
      evaluation: { verdict: claim.kind === 'premise_fact' ? 'supported' : 'unverifiable', flags: [] },
    }));
    const metrics = calculateQualityMetrics(claims);
    assert.equal(metrics.premiseFactCount, 1);
    assert.equal(metrics.keyClaimCount, 1);
    assert.equal(metrics.rates.supportedRate, 0);
  });

  it('fails closed when a premise lacks first-party direct body support', () => {
    const snippetFinding = {
      ...officialFinding,
      sources: [{
        id: 'src-snip',
        url: 'https://news.test/commerce',
        snippet: 'Retailers keep the shelf',
        fetchStatus: 'ok',
        assessment: { firstParty: false, publisherType: 'media' },
      }],
    };
    const aligned = alignClaimToCitedPassages({
      kind: 'premise_fact',
      text: 'Retailers keep the shelf. [1.1]',
      citationKeys: ['1.1'],
    }, {
      passages: [],
      citationMap: new Map([['1.1', { sourceId: 'src-snip' }]]),
      strategy: 'exploratory',
      strictDirectEvidence: true,
    });
    const gated = applySlotStatusToClaims([{
      ...aligned,
      evaluation: { verdict: 'supported', flags: aligned.flags },
    }], { gaps: judgmentGaps, findings: [snippetFinding] });
    assert.ok(gated[0].flags.includes('slot_premise_rejected'));
    assert.equal(shouldMoveWeakPremiseFact(gated[0]), true);
  });

  it('keeps background facts, moves unsupported judgment, and strips empty Key Findings', () => {
    const narrative = `# Research Report

## Summary
${longSummary}

## Confirmed Background Facts
- ${longBackground}

## Key Findings
- Retailers therefore keep the shelf. [1.1]
- Claude therefore locks the standard. [1.1]
`;
    const claims = [
      {
        kind: 'key_claim',
        text: longSummary,
        flags: ['slot_limited'],
        evaluation: { verdict: 'unverifiable', flags: ['slot_limited'] },
      },
      {
        kind: 'premise_fact',
        text: longBackground,
        flags: ['slot_premise_exempt'],
        evaluation: { verdict: 'supported', flags: ['slot_premise_exempt'] },
      },
      {
        kind: 'key_claim',
        text: 'Retailers therefore keep the shelf. [1.1]',
        flags: ['slot_limited'],
        evaluation: { verdict: 'unverifiable', flags: ['slot_limited'] },
      },
      {
        kind: 'key_claim',
        text: 'Claude therefore locks the standard. [1.1]',
        flags: ['slot_limited'],
        evaluation: { verdict: 'unverifiable', flags: ['slot_limited'] },
      },
    ];
    const revised = reviseUnsupportedKeyClaims(narrative, claims);
    assert.doesNotMatch(revised.report, /## Key Findings/);
    assert.match(revised.report, /Confirmed Background Facts/);
    assert.match(revised.report, /open-source blueprint/);
    assert.doesNotMatch(revised.report, /keep the shelf/);
    assert.doesNotMatch(revised.report, /locks the standard/);
    const assembled = assembleReport({
      narrative: revised.report,
      findings: [officialFinding],
      limitations: buildResearchLimitations({
        gaps: judgmentGaps,
        movedClaims: revised.moved,
        stopDetail: 'query_planner_exhausted',
      }).limitations,
      query: 'Commerce Agents judgment',
    });
    assert.equal((assembled.match(/first-party bodies were read but they are not sufficient/gi) || []).length, 1);
    assert.doesNotMatch(assembled, /media paraphrase/);
    const metrics = calculateQualityMetrics([
      ...extractQualityClaims(revised.report).filter((claim) => claim.kind === 'premise_fact').map((claim) => ({
        ...claim,
        evaluation: { verdict: 'supported', flags: ['slot_premise_exempt'] },
      })),
      {
        kind: 'key_claim',
        text: 'Retailers therefore keep the shelf.',
        evaluation: { verdict: 'unverifiable', flags: ['slot_limited'] },
      },
    ]);
    assert.equal(metrics.rates.supportedRate, 0);
    assert.equal(metrics.premiseFactSupportedCount, 1);
  });

  it('does not let a long Evidence section hide a short narrative', () => {
    const short = `# Research Report

## Summary
Short.

## Evidence
${'Long evidence body. '.repeat(40)}

## Caveats
- A limitation.

## Sources
- [1.1] Official | https://www.claude.com/blog
`;
    const check = validateReportOutput(short, { minChars: 200, mode: 'full', findings: [officialFinding] });
    assert.equal(check.ok, false);
    assert.ok(check.flags.includes('report_short_narrative'));
  });

  it('removes an uncited weak Summary paragraph and rejects internal gap ids as citations', () => {
    const weakSummary = 'The internal judgment slot remains unresolved [gap-2].';
    const narrative = `# Research Report

## Summary
${weakSummary}

## Confirmed Background Facts
- ${longBackground}
`;
    const revised = reviseUnsupportedKeyClaims(narrative, [{
      kind: 'key_claim',
      section: 'Summary',
      text: weakSummary,
      flags: ['uncited'],
      evaluation: { verdict: 'unverifiable', flags: ['uncited'] },
    }]);
    assert.doesNotMatch(revised.report, /gap-2/);
    assert.doesNotMatch(revised.report, /internal judgment slot/);
    assert.match(revised.report, /Required answer slots remain limited or blocked/);
    const invalid = validateReportOutput(narrative, {
      minChars: 1,
      mode: 'narrative',
      findings: [officialFinding],
      openJudgment: true,
    });
    assert.equal(invalid.ok, false);
    assert.ok(invalid.flags.includes('report_internal_reference_token'));
  });

  it('removes a multi-sentence Summary paragraph when a non-leading atomic claim is weak', () => {
    const parent = 'Anthropic published an open-source blueprint [1.1]. The internal judgment remains unresolved [gap-2].';
    const narrative = `# Research Report

## Summary
${parent}

## Confirmed Background Facts
- ${longBackground}
`;
    const revised = reviseUnsupportedKeyClaims(narrative, [{
      kind: 'key_claim',
      section: 'Summary',
      text: 'The internal judgment remains unresolved [gap-2].',
      parentClaimText: parent,
      flags: ['uncited'],
      evaluation: { verdict: 'unverifiable', flags: ['uncited'] },
    }]);
    assert.doesNotMatch(revised.report, /internal judgment/);
    assert.doesNotMatch(revised.report, /gap-2/);
    assert.match(revised.report, /Required answer slots remain limited or blocked/);
    assert.match(revised.report, /Confirmed Background Facts/);
  });

  it('allows an incomplete judgment narrative when cited premise facts remain', () => {
    const report = `# Research Report

## Summary
${longSummary}

## Confirmed Background Facts
- ${longBackground}
`;
    const check = validateReportOutput(report, {
      minChars: 200,
      mode: 'narrative',
      findings: [officialFinding],
      openJudgment: true,
    });
    assert.equal(check.ok, true, check.flags.join(','));
    const closedContract = buildReportContract({
      gaps: [{ id: 'gap-2', requiredSlot: true, status: 'verified', evidenceStatus: 'verified', contractSlotId: 'judgment', answerSlot: 'judgment' }],
      brief: { queryShape: 'judgment' },
    });
    assert.equal(validateReportPlan({ keyFindings: [] }, closedContract).ok, false);
    assert.equal(validateReportOutput(report, { minChars: 200, mode: 'narrative', findings: [officialFinding] }).ok, true);
  });
});

describe('post-revision narrative retry', () => {
  const longEnough = 'Anthropic describes Commerce Agents as an open-source blueprint that retailers can fork, and this sentence is long enough to keep the labeled narrative above the minimum. [1.1]';

  it('keeps a cited first-party background fact after unsupported judgment claims are revised', async () => {
    let reportCalls = 0;
    const result = await new ResearchRunner().run({
      query: 'Anthropic Commerce Agents official design',
      settings: {
        llm: {},
        search: {},
        research: {
          strategy: 'focused',
          iterations: 1,
          questionsPerIteration: 0,
          quality: { entailment: 'rules' },
          focused: {
            fetchMode: 'disabled',
            iterationControl: { enabled: false },
            evidencePassages: { enabled: true, claimAlignment: true },
          },
        },
      },
      search: {
        async search() {
          return [{
            title: 'Commerce Agents',
            url: 'https://www.claude.com/blog/commerce-agents',
            content: FIRST_PARTY_BODY,
            fetchStatus: 'ok',
            contentOrigin: 'fetched',
            assessment: { firstParty: true, publisherType: 'official', contentKind: 'article' },
          }];
        },
      },
      llm: {
        async complete({ purpose, messages }) {
          if (purpose === 'search_query_planning') return defaultSearchQueryPlan(messages);
          if (purpose === 'research_profile') {
            return JSON.stringify({
              queryShape: 'judgment',
              requiredAnswerSlots: [{
                id: 'judgment',
                answerSlot: 'judgment',
                question: 'Does Commerce Agents lock the shelf to Claude?',
                evidenceCriteria: ['first_party'],
              }],
            });
          }
          if (purpose === 'gap_support') {
            return JSON.stringify({ judgments: [{ verdict: 'unsupported', quote: 'open-source blueprint' }] });
          }
          if (purpose === 'question_generation') return '[]';
          if (purpose === 'report') {
            reportCalls += 1;
            return JSON.stringify({
              title: 'Commerce Agents',
              summary: [longSummary],
              backgroundFacts: [longEnough],
              keyFindings: [{ heading: '判断', claims: ['Retailers keep the shelf. [1.1]', 'Claude locks the standard. [1.1]'] }],
              caveats: ['Required judgment remains open.'],
            });
          }
          return '{}';
        },
      },
    });
    assert.ok(reportCalls >= 1);
    assert.match(result.report, /Confirmed Background Facts|已确认背景事实/);
    assert.doesNotMatch(result.report.split('## Evidence')[0], /Retailers keep the shelf/);
    assert.doesNotMatch(result.report.split('## Evidence')[0], /Claude locks the standard/);
    assert.equal(result.quality.claimExtractionVersion, 7);
    assert.ok(result.gaps.some((gap) => gap.id === 'gap-2' || gap.contractSlotId === 'judgment'));
    assert.equal(result.quality.completionStatus, 'incomplete');
    assert.equal(result.quality.metrics.rates.supportedRate, 0);
    assert.ok((result.quality.metrics.premiseFactCount || 0) >= 1);
  });

});

describe('empty heading cleanup', () => {
  it('strips empty Key Findings and leftover h3 shells', () => {
    const cleaned = stripEmptyNarrativeSections(`# Research Report

## Summary
${longSummary}

## Key Findings

### 判断

## Confirmed Background Facts
- ${longBackground}
`);
    assert.doesNotMatch(cleaned, /## Key Findings/);
    assert.doesNotMatch(cleaned, /### 判断/);
    assert.match(cleaned, /Confirmed Background Facts/);
  });

  it('keeps Key Findings when only H3 children have body text', () => {
    const cleaned = stripEmptyNarrativeSections(`# Research Report

## Summary
${longSummary}

## Key Findings

### 判断
- Anthropic published Commerce Agents as an open-source blueprint that retailers can fork. [1.1]

## Confirmed Background Facts
- ${longBackground}
`);
    assert.match(cleaned, /## Key Findings/);
    assert.match(cleaned, /### 判断/);
    assert.match(cleaned, /open-source blueprint/);
  });
});
