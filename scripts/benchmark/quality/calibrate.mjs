import fs from 'node:fs';
import path from 'node:path';
import { EvidenceStore } from 'js-deepresearch-engine';
import { hash, readJson, writeJson, invariant, JUDGE_VERSION } from './schema.mjs';
import { Judge } from './judge.mjs';
import { verifyFacts } from './evaluate.mjs';
import { extractReportFacts } from './report-facts.mjs';
import { isTechnical } from './statements.mjs';

export async function calibrate({ llm, identity, directory, fixtureFile = 'tests/fixtures/research-quality/calibration.json',
  holdoutFile }) {
  invariant(holdoutFile, 'A fresh versioned holdout file is required for calibration');
  const fixture = readJson(fixtureFile);
  const holdout = readJson(holdoutFile);
  invariant(holdout.judgeVersion === JUDGE_VERSION, 'Holdout judge version differs; exposed v3 cases cannot certify this judge');
  invariant(holdout.cases.length >= 20, 'At least 20 frozen holdout cases required');
  const exposed = readJson('tests/fixtures/research-quality/calibration-holdout-v3.json');
  const textKey = value => value.replace(/\s+/g, '').toLowerCase();
  const knownReports = new Set([...fixture.cases, ...exposed.cases].map(c => textKey(c.report)));
  invariant(holdout.cases.every(c => c.split === 'holdout' && !knownReports.has(textKey(c.report)))
    && new Set(holdout.cases.map(c => textKey(c.report))).size === holdout.cases.length, 'Holdout contains exposed or duplicate cases');
  const cases = [...fixture.cases.map(c => ({ ...c, split: 'development' })), ...holdout.cases];
  const calibrationIdentity = { fixtureHash: hash(fixture), holdoutHash: hash(holdout), judgeVersion: JUDGE_VERSION, identity };
  const identityFile = path.join(directory, 'inputs.json');
  if (fs.existsSync(identityFile)) invariant(hash(readJson(identityFile)) === hash(calibrationIdentity), 'Calibration inputs changed; use a new output directory');
  else writeJson(identityFile, calibrationIdentity);
  const store = new EvidenceStore();
  const v = store.register({ url: 'https://example.test/oriel/v1', content: fixture.body, fetchStatus: 'ok' }, 'task');
  const p = store.chunks(v.documentVersionId)[0];
  const gold = { schemaVersion: 1, topicId: 'synthetic', rubricVersion: 'calibration-1', goldHash: hash(fixture.criteria), reviewStatus: 'agent_verified',
    sources: [{ id: 'manual', url: 'https://example.test/oriel/v1', version: 'synthetic v1', text: fixture.body }],
    criteria: fixture.criteria.map(c => ({ ...c, weight: 2, core: true, critical: true, requirementIds: [],
      anchors: [{ sourceId: 'manual', span: [0, fixture.body.length] }] })) };
  const judge = new Judge({ llm, identity, directory: path.join(directory, 'judge'), limit: 100000 });
  const results = [];
  for (const item of cases) {
    const file = path.join(directory, `${item.id}.json`);
    let score;
    if (fs.existsSync(file)) {
      score = readJson(file);
      invariant(hash(score.calibrationIdentity) === hash(calibrationIdentity), 'Calibration inputs changed; use a new output directory');
    }
    else {
      const artifact = { report: `# Synthetic test\n\n${item.report}`, reportHash: hash(item.report), pin: { resultRevision: item.id }, result: { quality: item.execution || {} }, store,
        registry: { schemaVersion: 1, entries: [{ citationKey: '1.1', documentVersionId: v.documentVersionId, sourceId: v.sourceId, passageIds: [p.id] }] } };
      const extracted = await extractReportFacts(artifact.report, judge);
      const facts = await verifyFacts({ artifact, gold, facts: extracted.facts,
        caseDefinition: { scope: 'Fictional Oriel v1, only supplied manual establishes truth', query: item.query || 'Investigate Oriel v1.' }, judge });
      score = { ...extracted, judgments: { facts }, calibrationIdentity };
      writeJson(file, score);
    }
    const selected = score.judgments.facts.filter(f => !item.technicalOnly || isTechnical(score.facts.find(x => x.id === f.id)));
    const observed = selected.map(f => f.truth);
    const matched = score.extractionComplete && observed.length > 0 && observed.every(v => v === item.expectedTruth)
      && (!item.expectedKinds || score.facts.every(f => item.expectedKinds.includes(f.kind)))
      && (!item.expectedCitation || selected.some(f => f.citations.length) && selected.every(f => f.citations.every(c => c.verdict === item.expectedCitation)));
    const criticalMiss = item.expectedTruth === 'incorrect' && observed.some(v => v === 'correct');
    results.push({ id: item.id, split: item.split, expected: item.expectedTruth, observed, matched, criticalMiss,
      kinds: score.facts.map(f => f.kind), extractionComplete: score.extractionComplete });
    console.log(JSON.stringify({ calibration: item.id, matched, criticalMiss }));
  }
  const labels = ['correct', 'partial', 'incorrect', 'unverifiable', 'pending_review'];
  const confusion = Object.fromEntries(labels.map(a => [a, Object.fromEntries(labels.map(b => [b, 0]))]));
  for (const r of results) for (const v of r.observed) confusion[r.expected][v]++;
  const summary = { schemaVersion: 1, ...calibrationIdentity, labeledBy: 'codex-agent', humanReviewed: false,
    examples: results.length, agreement: results.filter(r => r.matched).length / results.length,
    criticalMisses: results.filter(r => r.criticalMiss).length, confusion, results, usage: judge.usage() };
  const reserved = results.filter(r => r.split === 'holdout');
  summary.holdoutAgreement = reserved.filter(r => r.matched).length / reserved.length;
  summary.machineCalibrationPassed = summary.holdoutAgreement >= 0.9 && summary.criticalMisses === 0
    && results.every(r => r.extractionComplete && r.observed.length && !r.observed.includes('pending_review'));
  writeJson(path.join(directory, 'calibration.json'), summary); return summary;
}
