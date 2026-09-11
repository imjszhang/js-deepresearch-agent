import { exactIds, invariant } from './schema.mjs';
import { evidenceTimeline, diagnosisTiming } from './timeline.mjs';

const terms = text => new Set(String(text).toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) || []);
const stages = ['discovery_gap', 'read_gap', 'extraction_gap', 'adjudication_error', 'binding_gap', 'report_omission', 'render_semantic_error', 'unattributable'];
export function validateDiagnoses(value, criterionId, candidates, claims) {
  exactIds(value.diagnoses, [criterionId]);
  const failures = value.diagnoses[0].failures;
  invariant(Array.isArray(failures) && failures.length > 0 && new Set(failures.map(f => f.stage)).size === failures.length, 'Invalid failure stages');
  for (const d of failures) {
    invariant(stages.includes(d.stage) && ['high', 'medium', 'low'].includes(d.confidence) && Array.isArray(d.contextIds) && Array.isArray(d.claimIds)
      && d.contextIds.every(id => candidates.some(c => c.id === id)) && d.claimIds.every(id => claims.some(c => c.claimId === id)), 'Invalid diagnosis');
    invariant(!['extraction_gap', 'adjudication_error', 'binding_gap', 'report_omission', 'render_semantic_error'].includes(d.stage) || d.contextIds.length > 0, 'Diagnosis without observed body');
    invariant(!['adjudication_error', 'binding_gap', 'report_omission', 'render_semantic_error'].includes(d.stage) || d.claimIds.length > 0, 'Diagnosis without claim');
  }
  invariant(failures.length === 1 || !failures.some(d => d.stage === 'unattributable'), 'Unknown attribution cannot imply another proven stage');
}
export function candidatesFor(criterion, gold, artifact, limit = 5) {
  const text = criterion.anchors.map(a => gold.sources.find(s => s.id === a.sourceId).text.slice(...a.span)).join(' ');
  const keywords = terms(text);
  const candidates = [];
  for (const version of artifact.store.versions.values()) {
    const body = artifact.store.body(version.documentVersionId);
    for (let start = 0; start < body.length; start += 1800) {
      const snippet = body.slice(start, start + 2400);
      const overlap = [...terms(snippet)].filter(t => keywords.has(t)).length;
      candidates.push({ documentVersionId: version.documentVersionId, span: [start, Math.min(start + 2400, body.length)], text: snippet,
        url: version.url, overlap });
    }
  }
  // Ranking only selects review context. It never awards coverage or proves absence.
  return candidates.sort((a, b) => b.overlap - a.overlap).slice(0, limit).map((c, i) => ({ ...c, id: `context-${i + 1}` }));
}
export async function diagnose({ score, artifact, gold, judge }) {
  const results = [];
  const timeline = evidenceTimeline(artifact.pin.sessionDir, artifact.pin.resultRevision);
  for (const row of score.rows.filter(r => r.evidencePoints < 1)) {
    const criterion = gold.criteria.find(c => c.id === row.id);
    const candidates = candidatesFor(criterion, gold, artifact);
    const selectedVersions = new Set(candidates.map(c => c.documentVersionId));
    const passages = [...artifact.store.passages.values()].filter(p => selectedVersions.has(p.documentVersionId));
    const claims = (artifact.result.reportPlan?.claimRecords || []).filter(c => [...(c.supportRefs || []), ...(c.counterRefs || [])].some(r => selectedVersions.has(r.documentVersionId)));
    const bindings = (artifact.result.reportPlan?.bindings || []).filter(b => claims.some(c => c.claimId === b.claimId));
    const sources = (artifact.result.sources || []).map(s => ({ id: s.id, url: s.url, fetchStatus: s.fetchStatus }));
    const p = await judge.ask('diagnose',
      'Diagnose a failed criterion using only supplied saved observations. JSON {diagnoses:[{id,failures:[{stage:"discovery_gap"|"read_gap"|"extraction_gap"|"adjudication_error"|"binding_gap"|"report_omission"|"render_semantic_error"|"unattributable",contextIds:[],claimIds:[],confidence:"high"|"medium"|"low"}]}]}. Multiple distinct failure stages are allowed only with observed supporting references for each; do not infer that one failure caused all later stages. Use unattributable alone if evidence is insufficient. Body contexts are partial candidates, not exhaustive. Lack of an answer in these candidates cannot prove discovery/read failure: use unattributable. extraction_gap needs an answer in actual body context but no corresponding usable claim. adjudication_error needs a claim contradicting supplied body/version or misclassified evidence. binding_gap needs a correct claim without appropriate binding. report_omission needs a correct bound claim absent from main report. Stored supported labels are not truth. Never claim web-wide absence. No reasoning text.',
      { criterion: { id: criterion.id, expectedAnswer: criterion.expectedAnswer, qualifiers: criterion.qualifiers },
        finalFacts: score.facts.filter(f => row.factIds.includes(f.id)), candidates,
        passages: passages.map(p => ({ id: p.id, documentVersionId: p.documentVersionId, startChar: p.startChar, endChar: p.endChar })),
        claims, bindings, sources }, p => validateDiagnoses(p, criterion.id, candidates, claims), 1800);
    const failures = p.diagnoses[0].failures.sort((a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage));
    for (const d of failures) results.push({ id: criterion.id, ...d, earliestObservedStage: failures[0].stage,
      reviewStatus: 'machine_draft', searchTraceExhaustive: false,
      contexts: candidates.filter(c => d.contextIds.includes(c.id)).map(({ id, documentVersionId, span, url }) => ({ id, documentVersionId, span, url })) });
  }
  return { diagnoses: results.map(d => ({ ...d, timing: diagnosisTiming(d, timeline) })), timeline,
    telemetryLimitations: ['Candidate contexts are not exhaustive.', ...timeline.limitations] };
}
