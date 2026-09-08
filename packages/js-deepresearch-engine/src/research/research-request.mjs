import { createHash, randomUUID } from 'node:crypto';
import { sanitizeAsOf } from './research-brief.mjs';

export const EXECUTION_VERSION = 2;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const kinds = new Set(['fact', 'comparison', 'derived_judgment']);

export function normalizePlanningContext(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('planningContext must be an object.');
  const out = {};
  for (const key of ['questions', 'identityHints', 'readingHints']) {
    if (value[key] == null) continue;
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== 'string')) {
      throw new TypeError(`planningContext.${key} must be an array of strings.`);
    }
    out[key] = [...new Set(value[key].map((item) => item.trim()).filter(Boolean))].slice(0, 20);
  }
  const unknown = Object.keys(value).filter((key) => !['questions', 'identityHints', 'readingHints'].includes(key));
  if (unknown.length) throw new TypeError('planningContext only accepts questions, identityHints and readingHints.');
  if (JSON.stringify(out).length > 20000) throw new TypeError('planningContext exceeds 20000 characters.');
  return out;
}

function explicitInputTasks(query) {
  const tasks = [];
  function add(text, startChar) {
    const value = text.trim();
    if (!value) return;
    tasks.push({ id: `input-${startChar}`, question: value, answerSlot: value, requiredSlot: true, priority: 'critical',
      taskType: /比较|对比|compare/i.test(value) ? 'comparison' : /建议|适用场景|recommend/i.test(value) ? 'derived_judgment' : 'fact',
      basisRange: [startChar, startChar + text.length], requiredHosts: [], requiredSourceTypes: [], evidenceCriteria: [] });
  }
  for (const match of query.matchAll(/(?:系统调查|调查以下|调研以下|研究以下|请分别回答|请比较|包括以下)\s*[：:]\s*([^。；;\n]+)/g)) {
    const list = match[1];
    const offset = match.index + match[0].lastIndexOf(list);
    for (const item of list.matchAll(/[^、，,]+/g)) add(item[0], offset + item.index);
  }
  for (const match of query.matchAll(/^\s*\d+[.)、]\s*([^\n]+)/gm)) add(match[1], match.index + match[0].lastIndexOf(match[1]));
  for (const match of query.matchAll(/最后给出\s*([^。；;\n]+)/g)) {
    for (const item of match[1].matchAll(/[^、，,]+/g)) {
      // Questions about unknowns and report limitations are presentation obligations,
      // not factual assertions requiring a quote that proves absence.
      if (/待验证|调研限制|研究限制|不确定/.test(item[0])) continue;
      add(item[0], match.index + match[0].lastIndexOf(match[1]) + item.index);
    }
  }
  return tasks;
}

// Only called at a trusted run entry, never with provider output or checkpoint data.
export function createResearchRequest(input, { planningContext, inputSource = 'engine' } = {}) {
  const structured = typeof input === 'object' && input !== null;
  const originalQuery = structured ? String(input.query || '') : String(input || '');
  if (!originalQuery.trim()) throw new TypeError('Research query is required.');
  if (structured) {
    if (input.requiredAnswerSlots != null && !Array.isArray(input.requiredAnswerSlots)) throw new TypeError('requiredAnswerSlots must be an array.');
    for (const object of [input, ...(input.requiredAnswerSlots || [])]) {
      if (!object || typeof object !== 'object') throw new TypeError('Answer slots must be objects.');
      for (const key of ['requiredHosts', 'requiredSourceTypes', 'evidenceCriteria']) {
        if (object[key] != null && (!Array.isArray(object[key]) || object[key].some((value) => typeof value !== 'string' || !value.trim()))) throw new TypeError(`${key} must be an array of nonempty strings.`);
      }
      if (object.requiredSourceTypes?.some((value) => !['primary_filing', 'numeric'].includes(value))) throw new TypeError('Unsupported requiredSourceTypes; describe other source restrictions in the original query.');
      if (object.requiredHosts?.some((value) => !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(value))) throw new TypeError('Invalid required host.');
      if (object.requiredHostMode != null && !['any', 'all'].includes(object.requiredHostMode)) throw new TypeError('Invalid requiredHostMode.');
    }
    if (input.minIndependentSources != null && (!Number.isSafeInteger(input.minIndependentSources) || input.minIndependentSources < 1)) throw new TypeError('minIndependentSources must be a positive integer.');
    if (input.asOf != null && !sanitizeAsOf(input.asOf)) throw new TypeError('asOf must contain a valid ISO date.');
  }
  return {
    schemaVersion: 1, requestId: randomUUID(), originalQuery, queryHash: hash(originalQuery),
    inputSource, planningContext: normalizePlanningContext(planningContext ?? (structured ? input.planningContext : null)),
    inputTasks: explicitInputTasks(originalQuery),
    explicitSlots: structured ? globalThis.structuredClone(input.requiredAnswerSlots || []) : [],
    explicitProfile: structured ? Object.fromEntries(['requiredHosts', 'requiredSourceTypes', 'minIndependentSources', 'requiredHostMode', 'asOf']
      .filter((key) => input[key] != null).map((key) => [key, globalThis.structuredClone(input[key])])) : {},
  };
}

function constraint(request, kind, value, { path, range, origin = 'explicit_input', strength = 'required' } = {}) {
  const basisRef = origin === 'system_policy'
    ? { policyId: 'minimum-evidence-answer', version: 1 }
    : { requestId: request.requestId, ...(path ? { path } : { startChar: range?.[0] ?? 0, endChar: range?.[1] ?? request.originalQuery.length }) };
  return { id: `constraint-${hash(JSON.stringify([request.queryHash, kind, value, basisRef])).slice(0, 20)}`,
    kind, value, origin, strength, basisRef, validationStatus: 'validated', revision: 1 };
}

export function applyRequestContract(profile, incomingBrief) {
  const request = incomingBrief?.request;
  if (request?.schemaVersion !== 1) return profile; // Legacy contracts retain their original semantics.
  const explicit = request.explicitSlots.length ? (incomingBrief.requiredAnswerSlots || []) : request.inputTasks || [];
  const proposals = profile.brief?.requiredAnswerSlots || [];
  const constraints = [];
  const userSlots = explicit.map((slot, index) => {
    const c = constraint(request, 'answer', slot.question, slot.basisRange ? { range: slot.basisRange } : { path: `requiredAnswerSlots/${index}` });
    constraints.push(c);
    for (const key of ['requiredHosts', 'requiredSourceTypes', 'evidenceCriteria']) {
      for (const value of slot[key] || []) constraints.push(constraint(request, key, value, { path: `requiredAnswerSlots/${index}/${key}` }));
    }
    return { ...slot, taskType: kinds.has(slot.taskType) ? slot.taskType : 'fact', origin: 'explicit_input', constraintIds: [c.id] };
  });
  const root = constraint(request, 'answer', request.originalQuery);
  constraints.push(root, constraint(request, 'evidence_validity', 'anchored_evidence_or_explicit_limitation', { origin: 'system_policy' }));
  const literalHosts = [...new Set((request.originalQuery.match(/\b(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|io|hk|cn|uk|jp|ai|info)\b/gi) || []).map((host) => host.toLowerCase().replace(/^www\./, '')))];
  const hardHosts = [...new Set([...literalHosts, ...(request.explicitProfile.requiredHosts || [])])];
  for (const host of hardHosts) constraints.push(constraint(request, 'requiredHosts', host,
    literalHosts.includes(host) ? { range: [request.originalQuery.toLowerCase().indexOf(host), request.originalQuery.toLowerCase().indexOf(host) + host.length] } : { path: 'requiredHosts' }));
  let minIndependentSources = request.explicitProfile.minIndependentSources || 1;
  for (const match of request.originalQuery.matchAll(/(?:至少|at least)\s*(\d+)\s*(?:个|家|份)?\s*(?:独立来源|independent sources)/gi)) {
    minIndependentSources = Math.max(minIndependentSources, Number(match[1]));
    constraints.push(constraint(request, 'minIndependentSources', Number(match[1]), { range: [match.index, match.index + match[0].length] }));
  }
  for (const key of ['requiredSourceTypes', 'minIndependentSources', 'requiredHostMode']) {
    if (request.explicitProfile[key] != null) constraints.push(constraint(request, key, request.explicitProfile[key], { path: key }));
  }
  const freshnessBasis = /(?:截至|截止|\bas of\b)\s*\d{4}(?:[-年/]\d{1,2})?/i.exec(request.originalQuery);
  if (freshnessBasis) constraints.push(constraint(request, 'freshness', freshnessBasis[0], {
    range: [freshnessBasis.index, freshnessBasis.index + freshnessBasis[0].length],
  }));
  if (request.explicitProfile.asOf != null) constraints.push(constraint(request, 'freshness', request.explicitProfile.asOf, { path: 'asOf' }));
  for (const match of request.originalQuery.matchAll(/(?:必须|不得|不要|只能|仅限|只用|仅用|至少|\bmust\b|\bonly\b|\bat least\b)[^。；;\n.!?]*/gi)) {
    if (/^(?:至少|at least)\s*\d+\s*(?:个|家|份)?\s*(?:独立来源|independent sources)\s*$/i.test(match[0])) continue;
    const item = constraint(request, 'unresolved_request_constraint', match[0], { range: [match.index, match.index + match[0].length] });
    constraints.push({ ...item, validationStatus: 'unresolved' });
  }
  const rootSlot = {
    id: 'request-answer', answerSlot: request.originalQuery, question: request.originalQuery,
    taskType: profile.brief?.queryShape === 'judgment' ? 'derived_judgment' : profile.brief?.queryShape === 'comparison' ? 'comparison' : 'fact',
    priority: 'critical', requiredSlot: true, origin: 'explicit_input', constraintIds: [root.id],
    requiredHosts: hardHosts, requiredSourceTypes: request.explicitProfile.requiredSourceTypes || [],
    requiredHostMode: request.explicitProfile.requiredHostMode || 'any', evidenceCriteria: [], preferredHosts: [],
  };
  const suggested = proposals.filter((slot) => !userSlots.some((user) => user.id === slot.id || user.question === slot.question))
    .filter((slot) => slot.question !== request.originalQuery).map((slot, index) => ({
      ...slot, id: `plan-${index + 1}`, priority: 'normal', requiredSlot: false, origin: 'planner_suggestion',
      taskType: kinds.has(slot.taskType) ? slot.taskType : 'fact', constraintIds: [], parentTaskId: userSlots[0]?.id || rootSlot.id,
      preferredHosts: [...new Set([...(slot.preferredHosts || []), ...(slot.requiredHosts || [])])],
      requiredHosts: [], requiredSourceTypes: [], evidencePreferences: slot.evidenceCriteria || [], evidenceCriteria: [],
    }));
  const slots = [...(userSlots.length ? userSlots : [rootSlot]), ...suggested];
  const brief = { ...profile.brief, schemaVersion: 3, request, executionVersion: EXECUTION_VERSION,
    query: request.originalQuery, requiredAnswerSlots: slots, constraints, contractOrigin: 'request',
    researchPlan: { schemaVersion: 1, revision: 1, tasks: slots, changes: [] },
  };
  return { ...profile, brief, requiredHosts: hardHosts,
    flags: { ...profile.flags, freshness: Boolean(freshnessBasis || request.explicitProfile.asOf) }, maxAgeDays: null,
    preferredHosts: [...new Set([...(profile.preferredHosts || []), ...(profile.requiredHosts || []).filter((host) => !hardHosts.includes(host))])],
    requiredSourceTypes: request.explicitProfile.requiredSourceTypes || [],
    minIndependentSources,
    requiredHostMode: request.explicitProfile.requiredHostMode || 'any', plannedGaps: suggested,
    contractUnavailable: false, contractFailure: null,
  };
}
