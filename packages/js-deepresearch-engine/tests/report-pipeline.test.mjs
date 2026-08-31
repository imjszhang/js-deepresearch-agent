import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BudgetManager,
  ResearchRunner,
  assembleReport,
  extractQualityClaims,
  keepNarrativeSections,
  looksTruncated,
  normalizeCaveatKey,
  parseNarrativeResponse,
  reviseUnsupportedKeyClaims,
  shouldMoveWeakKeyClaim,
  validateNarrativeObject,
  validateReportOutput,
} from '../src/index.mjs';
import { emptyBulletLines } from '../src/research/report-builder.mjs';

const findings = [{
  question: 'What is Ollama?',
  sources: [{
    title: 'Ollama docs',
    url: 'https://ollama.com',
    summary: 'Ollama runs local models.',
    content: 'Ollama runs local models on Apple Silicon.',
    fetchStatus: 'ok',
    contentOrigin: 'fetched',
  }],
}];

describe('report completeness and assembly', () => {
  it('rejects a mid-sentence truncation', () => {
    const truncated = `# Research Report

## Summary
llama.cpp 支持 1.`;
    assert.equal(looksTruncated(truncated), true);
    const check = validateReportOutput(truncated, { minChars: 20, mode: 'narrative' });
    assert.equal(check.ok, false);
    assert.ok(check.flags.includes('report_truncated'));
  });

  it('rejects an empty placeholder Summary', () => {
    const empty = `# Research Report

## Summary
；；

## Key Findings
- llama.cpp treats Apple Silicon as a first-class backend [1.1].
`;
    const check = validateReportOutput(empty, { minChars: 20, mode: 'narrative', findings });
    assert.equal(check.ok, false);
    assert.ok(check.flags.includes('report_empty_summary'));
  });

  it('rejects a narrative that dumps source bodies into Key Findings', () => {
    const dumped = `# Research Report

## Summary
Ollama is a local model runner. [1.1]

## Key Findings
### 截至2026年8月，llama.cpp、MLX 与 Ollama 在 Apple Silicon 上做本地 LLM 推理的官方定位、性能取舍与推荐用法是什么？优先引用官方文档和 GitHub。
*   **[1.1] Ollama docs** (source body): Ollama runs local models on Apple Silicon.
`;
    const check = validateReportOutput(dumped, { minChars: 20, mode: 'narrative', findings });
    assert.equal(check.ok, false);
    assert.ok(check.flags.includes('report_contains_source_dump'));
  });

  it('drops query-heading source dumps before assembly', () => {
    const query = '截至2026年8月，llama.cpp、MLX 与 Ollama 在 Apple Silicon 上做本地 LLM 推理的官方定位、性能取舍与推荐用法是什么？优先引用官方文档和 GitHub。';
    const narrative = `# Research Report

## Summary
Ollama is a local model runner. [1.1]

## Key Findings

### 官方定位
- Ollama targets easy local inference. [1.1]

### ${query}
*   **[1.1] Ollama docs** (source body): Ollama runs local models on Apple Silicon.
`;
    const kept = keepNarrativeSections(narrative, { query });
    assert.match(kept, /官方定位/);
    assert.doesNotMatch(kept, /source body/);
    const assembled = assembleReport({ narrative, findings, query });
    assert.match(assembled, /## Evidence/);
    assert.equal(assembled.match(/source body/g)?.length, 1);
    const check = validateReportOutput(assembled, { minChars: 80, mode: 'full', findings });
    assert.equal(check.ok, true, check.flags.join(','));
  });

  it('stops narrative extraction at the first generated section even when source H1s follow', () => {
    const innerTitle = '可以做空房产么';
    const assembled = `# Research Report

## Summary
Ollama is a local model runner. [1.1]

## Key Findings
- Ollama targets easy local inference. [1.1]

## Evidence

### What is Ollama?
*   **[1.1] Ollama docs** (source body): excerpt only

# ${innerTitle}
Yesterday someone asked a question in the paid community.
`;
    const kept = keepNarrativeSections(assembled, { query: 'What is Ollama?' });
    assert.match(kept, /Ollama targets easy local inference/);
    assert.doesNotMatch(kept, /source body/);
    assert.doesNotMatch(kept, new RegExp(innerTitle));
    assert.doesNotMatch(kept, /paid community/);
  });

  it('assembles Evidence, Caveats, and Sources from findings', () => {
    const report = assembleReport({
      narrative: `# Research Report

## Summary
Ollama is a local model runner. [1.1]

## Key Findings
Ollama targets easy local inference. [1.1]
`,
      findings,
      limitations: ['Snippet-only sources cannot verify body facts.'],
      query: 'What is Ollama?',
    });
    assert.match(report, /## Summary/);
    assert.match(report, /## Evidence/);
    assert.match(report, /## Caveats/);
    assert.match(report, /## Sources/);
    assert.match(report, /https:\/\/ollama.com/);
    assert.match(report, /\[1\.1\]/);
    const check = validateReportOutput(report, { minChars: 80, mode: 'full', findings });
    assert.equal(check.ok, true, check.flags.join(','));
  });

  it('moves unsupported key claims into Caveats instead of prefixing Unverified', () => {
    const narrative = `# Research Report

## Summary
A complete summary of the researched topic remains after claim revision.

## Key Findings
- This key sentence has no backing evidence at all.
`;
    const assembled = assembleReport({ narrative, findings, query: 'topic' });
    const revised = reviseUnsupportedKeyClaims(keepNarrativeSections(assembled, { query: 'topic' }), [{
      kind: 'key_claim',
      text: 'This key sentence has no backing evidence at all.',
      evaluation: { verdict: 'unverifiable' },
    }]);
    assert.ok(!revised.report.includes('Unverified:'));
    assert.ok(!revised.report.includes('This key sentence has no backing evidence at all'));
    assert.equal(revised.moved.length, 1);
    const reassembled = assembleReport({
      narrative: revised.report,
      findings,
      limitations: revised.moved.map((text) => `Insufficient direct evidence for: ${text}`),
      query: 'topic',
    });
    assert.match(reassembled, /## Caveats/);
    assert.match(reassembled, /This key sentence has no backing evidence at all/);
    assert.equal(emptyBulletLines(reassembled).length, 0);
  });

  it('deletes whole claim bullets and keeps source-backed unverifiable claims', () => {
    const narrative = `# Research Report

## Summary
A complete summary of the researched topic remains after claim revision.

## Key Findings
- Weak claim with no backing evidence.
- Strong claim with a cited local body. [1.1]
`;
    const revised = reviseUnsupportedKeyClaims(narrative, [
      {
        kind: 'key_claim',
        text: 'Weak claim with no backing evidence.',
        evaluation: { verdict: 'unsupported' },
      },
      {
        kind: 'key_claim',
        text: 'Strong claim with a cited local body.',
        evaluation: { verdict: 'unverifiable', flags: [] },
        citedSourceIds: ['s1'],
        evidence: [{ passageId: 'p1', sourceId: 's1', evidenceOrigin: 'source_content' }],
      },
      {
        kind: 'key_claim',
        text: 'Snippet only leftover.',
        evaluation: { verdict: 'unverifiable', flags: ['snippet_only'] },
      },
    ]);
    assert.ok(!revised.report.includes('Weak claim with no backing evidence.'));
    assert.match(revised.report, /Strong claim with a cited local body/);
    assert.equal(revised.moved.includes('Weak claim with no backing evidence.'), true);
    assert.equal(revised.moved.includes('Strong claim with a cited local body.'), false);
    assert.equal(shouldMoveWeakKeyClaim({
      kind: 'key_claim',
      evaluation: { verdict: 'unverifiable', flags: ['snippet_only'] },
    }), true);
    assert.equal(emptyBulletLines(revised.report).length, 0);
  });

  it('deduplicates caveat text after stripping evidence prefixes', () => {
    const report = assembleReport({
      narrative: `# Research Report

## Summary
Enough narrative remains after caveat normalization.

## Key Findings
- A supported finding stays in the narrative. [1.1]

## Caveats
- The same limitation appears twice.
`,
      findings,
      limitations: ['Insufficient direct evidence for: The same limitation appears twice.'],
      query: 'topic',
    });
    const caveats = report.split('## Caveats')[1].split('## Sources')[0];
    assert.equal([...caveats.matchAll(/The same limitation appears twice/g)].length, 1);
    assert.equal(
      normalizeCaveatKey('Insufficient direct evidence for: The same limitation appears twice.'),
      normalizeCaveatKey('The same limitation appears twice。'),
    );
  });

  it('fails full validation when claim revision empties Key Findings', () => {
    const narrative = `# Research Report

## Summary
Short.

## Key Findings
- Only this unsupported sentence.
`;
    const revised = reviseUnsupportedKeyClaims(narrative, [{
      kind: 'key_claim',
      text: 'Only this unsupported sentence.',
      evaluation: { verdict: 'unsupported' },
    }]);
    const assembled = assembleReport({
      narrative: revised.report,
      findings,
      limitations: revised.moved.map((text) => `Insufficient direct evidence for: ${text}`),
      query: 'topic',
    });
    const check = validateReportOutput(assembled, { minChars: 80, mode: 'full', findings });
    assert.equal(check.ok, false);
    assert.ok(check.flags.includes('report_missing_key_claims') || check.flags.includes('report_empty_summary'));
  });

  it('writes a report after the exploration cap is exhausted', async () => {
    const result = await new ResearchRunner().run({
      query: 'budget topic',
      settings: {
        llm: {},
        search: {},
        research: {
          strategy: 'exploratory',
          exploratory: { minLlmTokens: 0, maxLlmTokens: 0, maxSteps: 4, maxEvaluationRetries: 0, autoReadTopK: 0 },
          focused: { fetchMode: 'disabled' },
          budget: { maxLlmTokens: 2500, maxSearchRequests: 4, maxSourceReads: 0 },
        },
      },
      search: { async search() {
        return [{ title: 'Cap', url: 'https://budget.test', content: 'Budget topic evidence.', fetchStatus: 'ok' }];
      } },
      llm: {
        async complete({ purpose }) {
          if (purpose === 'agent_decision') return JSON.stringify({ action: 'search', query: 'budget topic', gapId: 'gap-1' });
          if (purpose === 'gap_decomposition') return 'no json';
          return `# Research Report

## Summary
The selected source covers the budget topic with enough detail to write a complete narrative after exploration stops. [1.1]

## Key Findings
Budget topic evidence remains available after the exploration token cap is reached, so the final report can still be assembled. [1.1]
`;
        },
      },
    });
    assert.ok(result.report.length > 400);
    assert.match(result.report, /## Evidence/);
    assert.match(result.report, /## Sources/);
    assert.ok((result.quality.budget.usage.reportTokens || 0) >= 0);
    assert.ok((result.quality.budget.usage.llmTokens || 0) >= (result.quality.budget.usage.explorationTokens || 0));
  });
});

describe('structured narrative', () => {
  const jsonNarrative = {
    title: 'Ollama on Apple Silicon',
    summary: ['Ollama is a local model runner for Apple Silicon. [1.1]'],
    keyFindings: [{ heading: '定位', claims: ['Ollama targets easy local inference. [1.1]'] }],
    caveats: ['Benchmarks remain limited.'],
  };

  it('renders valid JSON into narrative Markdown and assembles Evidence once', () => {
    const parsed = parseNarrativeResponse(JSON.stringify(jsonNarrative));
    assert.equal(parsed.ok, true);
    assert.match(parsed.markdown, /## Summary/);
    assert.match(parsed.markdown, /## Key Findings/);
    assert.doesNotMatch(parsed.markdown, /## Evidence/);
    const assembled = assembleReport({ narrative: parsed.markdown, findings, query: 'What is Ollama?' });
    assert.equal(assembled.match(/## Evidence/g)?.length, 1);
    assert.match(assembled, /https:\/\/ollama.com/);
  });

  it('rejects JSON that includes Evidence or source dumps', () => {
    const withEvidence = validateNarrativeObject({
      ...jsonNarrative,
      evidence: [{ text: 'dump' }],
    });
    assert.equal(withEvidence.ok, false);
    assert.ok(withEvidence.flags.includes('narrative_has_generated_sections'));
    const dumped = parseNarrativeResponse(JSON.stringify({
      ...jsonNarrative,
      keyFindings: [{
        heading: '定位',
        claims: ['**[1.1] Ollama docs** (source body): Ollama runs local models on Apple Silicon.'],
      }],
    }));
    assert.equal(dumped.ok, false);
    assert.ok(dumped.flags.includes('narrative_contains_source_dump'));
  });

  it('falls back to Markdown when the model does not return JSON', async () => {
    const result = await new ResearchRunner().run({
      query: 'What is Ollama?',
      settings: {
        llm: {},
        search: {},
        research: {
          strategy: 'quick',
          iterations: 1,
          questionsPerIteration: 0,
          focused: { fetchMode: 'disabled', evidencePassages: { enabled: true, claimAlignment: true } },
        },
      },
      search: { async search() { return [{ title: 'Ollama docs', url: 'https://ollama.com', snippet: 'Ollama runs local models.' }]; } },
      llm: {
        async complete({ purpose }) {
          if (purpose === 'question_generation') return '[]';
          return `# Research Report

## Summary
Ollama is a local model runner for Apple Silicon and this fallback narrative is long enough to pass the report length contract. [1.1]

## Key Findings
- Ollama targets easy local inference on developer workstations. [1.1]
`;
        },
      },
    });
    assert.match(result.report, /## Summary/);
    assert.match(result.report, /## Evidence/);
    assert.doesNotMatch(result.report.split('## Evidence')[0], /source body/);
  });

  it('accepts JSON from the report model and keeps Evidence assembler-owned', async () => {
    const result = await new ResearchRunner().run({
      query: 'What is Ollama?',
      settings: {
        llm: {},
        search: {},
        research: {
          strategy: 'quick',
          iterations: 1,
          questionsPerIteration: 0,
          focused: { fetchMode: 'disabled', evidencePassages: { enabled: true, claimAlignment: true } },
        },
      },
      search: { async search() { return [{ title: 'Ollama docs', url: 'https://ollama.com', snippet: 'Ollama runs local models.' }]; } },
      llm: {
        async complete({ purpose }) {
          if (purpose === 'question_generation') return '[]';
          return JSON.stringify(jsonNarrative);
        },
      },
    });
    assert.match(result.report, /Ollama on Apple Silicon/);
    assert.equal(result.report.match(/## Evidence/g)?.length, 1);
    assert.match(result.report, /## Sources/);
  });

  it('revises only the canonical narrative and bounds Evidence to one passage', async () => {
    const innerTitle = '可以做空房产么';
    const longBody = `# ${innerTitle}\n\n${'房产交易需要注意税费和流动性。 '.repeat(80)}`;
    const result = await new ResearchRunner().run({
      query: '房产操作',
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
            evidencePassages: {
              enabled: true,
              claimAlignment: true,
              maxPassageChars: 180,
              maxPassagesPerSource: 5,
            },
          },
        },
      },
      search: {
        async search() {
          return [{
            title: '1480-可以做空房产么.md',
            url: 'file:///corpus/1480.md',
            content: longBody,
            fetchStatus: 'ok',
            contentOrigin: 'fetched',
          }];
        },
      },
      llm: {
        async complete({ purpose }) {
          if (purpose === 'question_generation') return '[]';
          return JSON.stringify({
            title: '房产操作',
            summary: ['Local notes describe informal property tactics with enough detail to evaluate. [1.1]'],
            keyFindings: [{
              heading: '操作',
              claims: [
                'The source discusses informal holding arrangements in enough detail to evaluate. [1.1]',
                'This key sentence has no backing evidence at all.',
              ],
            }],
            caveats: [],
          });
        },
      },
    });

    assert.equal(result.report.match(/## Evidence/g)?.length, 1);
    assert.equal(result.report.match(/## Caveats/g)?.length, 1);
    assert.equal(result.report.match(/## Sources/g)?.length, 1);
    const narrative = result.report.split('## Evidence')[0];
    assert.doesNotMatch(narrative, /source body/);
    assert.doesNotMatch(narrative, new RegExp(innerTitle));
    assert.doesNotMatch(narrative, /This key sentence has no backing evidence at all/);
    assert.match(result.report, /Insufficient direct evidence for: This key sentence has no backing evidence at all/);
    assert.equal([...result.report.matchAll(/This key sentence has no backing evidence at all/g)].length, 1);
    const evidenceBlock = result.report.split('## Evidence')[1].split('## Caveats')[0];
    assert.match(evidenceBlock, /source body/);
    assert.doesNotMatch(evidenceBlock, new RegExp(longBody.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const displayed = evidenceBlock.match(/\(source body\):\s*(.*)$/m)?.[1] || '';
    assert.ok(displayed.length > 0 && displayed.length <= 180);
    assert.ok(result.passages.length >= 1);
    assert.ok(result.passages.every((passage) => passage.text.length <= 180));
    const keyClaims = result.claims.filter((claim) => claim.kind === 'key_claim');
    const evidenceLine = result.report.split('\n').findIndex((line) => /^## Evidence\b/.test(line)) + 1;
    assert.ok(keyClaims.every((claim) => claim.lineStart < evidenceLine));
    assert.deepEqual(
      keyClaims.map((claim) => claim.text),
      extractQualityClaims(narrative).filter((claim) => claim.kind === 'key_claim').map((claim) => claim.text),
    );
    assert.ok(result.claims.some((claim) => claim.kind === 'evidence_entry'));
  });
});

describe('report token budgeting', () => {
  it('omits report usage from the exploration hard-cap check', () => {
    const budget = new BudgetManager({ research: { budget: { maxLlmTokens: 1000 } } });
    budget.claim('llmTokens', 1000, { purpose: 'agent_decision' });
    assert.equal(budget.canClaim('llmTokens', 1), false);
    assert.equal(budget.canClaim('llmTokens', 2000, { purpose: 'report', report: true }), true);
  });
});
