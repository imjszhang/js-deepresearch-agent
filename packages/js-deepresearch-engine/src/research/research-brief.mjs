export const RESEARCH_BRIEF_SCHEMA_VERSION = 1;
export const RESEARCH_BRIEF_DEPTHS = Object.freeze(['quick', 'focused', 'exploratory']);
export const ANSWER_SLOT_PRIORITIES = Object.freeze(['critical', 'normal']);
const HOST_IN_QUERY = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|io|hk|cn|uk|jp|ai|info)\b/gi;
const HOSTNAME_SHAPE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/;
const KNOWN_SOURCE_TYPES = new Set(['primary_filing', 'numeric']);

function text(value, maxLength = 1000) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function uniqueText(values, maxItems = 20) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => text(value)).filter(Boolean))].slice(0, maxItems);
}

function sanitizeHosts(values) {
  return uniqueText(values).map((value) => value.toLowerCase().replace(/^www\./, ''))
    .filter((value) => HOSTNAME_SHAPE.test(value));
}

function sanitizeSourceTypes(values) {
  return uniqueText(values).filter((value) => KNOWN_SOURCE_TYPES.has(value));
}

function extractLiteralHosts(query) {
  return sanitizeHosts(String(query || '').match(HOST_IN_QUERY) || []);
}

function slotId(value, index) {
  const normalized = text(value, 80).replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-|-$/g, '');
  return normalized || `slot-${index + 1}`;
}

export function sanitizeAnswerSlots(slots, { query = '', literalHosts = [] } = {}) {
  if (!Array.isArray(slots)) return [];
  const allowedHosts = new Set(literalHosts);
  const seen = new Set();
  const result = [];
  for (const [index, raw] of slots.entries()) {
    const source = typeof raw === 'string' ? { question: raw, answerSlot: raw } : (raw || {});
    const answerSlot = text(source.answerSlot || source.label || source.question);
    const question = text(source.question || answerSlot || query);
    if (!answerSlot && !question) continue;
    let id = slotId(source.id || answerSlot || question, index);
    if (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    result.push({
      id,
      answerSlot: answerSlot || question,
      question: question || query,
      claimFamily: text(source.claimFamily || source.claimType, 120) || null,
      priority: ANSWER_SLOT_PRIORITIES.includes(source.priority) ? source.priority : 'normal',
      requiredHosts: sanitizeHosts(source.requiredHosts).filter((host) => allowedHosts.has(host)),
      requiredSourceTypes: sanitizeSourceTypes(source.requiredSourceTypes),
      successCriteria: uniqueText(source.successCriteria, 8),
    });
    if (result.length >= 20) break;
  }
  return result;
}

export function sanitizeResearchBrief(input = {}, { query, depth = 'focused' } = {}) {
  const source = typeof input === 'string' ? { query: input } : (input || {});
  const resolvedQuery = text(query || source.query);
  const resolvedDepth = RESEARCH_BRIEF_DEPTHS.includes(source.depth)
    ? source.depth
    : (RESEARCH_BRIEF_DEPTHS.includes(depth) ? depth : 'focused');
  const literalHosts = extractLiteralHosts(resolvedQuery);
  const requiredAnswerSlots = sanitizeAnswerSlots(source.requiredAnswerSlots, {
    query: resolvedQuery,
    literalHosts,
  });
  return {
    schemaVersion: RESEARCH_BRIEF_SCHEMA_VERSION,
    query: resolvedQuery,
    audience: text(source.audience) || null,
    decision: text(source.decision) || null,
    assumedExpertise: text(source.assumedExpertise, 120) || null,
    timeRange: source.timeRange == null ? null : text(source.timeRange, 200),
    geography: uniqueText(source.geography),
    entities: uniqueText(source.entities),
    exclusions: uniqueText(source.exclusions),
    depth: resolvedDepth,
    deadline: source.deadline == null ? null : text(source.deadline, 120),
    successCriteria: uniqueText(source.successCriteria),
    requiredAnswerSlots,
    consequentialClaims: uniqueText(source.consequentialClaims),
  };
}

export function researchBriefFromInput(input, { depth = 'focused' } = {}) {
  if (typeof input === 'string') return sanitizeResearchBrief({ query: input }, { depth });
  return sanitizeResearchBrief(input || {}, { depth });
}

export function mergeResearchBrief(base, plan = {}, options = {}) {
  const sanitizedBase = sanitizeResearchBrief(base, options);
  return sanitizeResearchBrief({
    ...sanitizedBase,
    ...plan,
    query: sanitizedBase.query,
    depth: sanitizedBase.depth,
    geography: plan.geography ?? sanitizedBase.geography,
    entities: plan.entities ?? sanitizedBase.entities,
    exclusions: plan.exclusions ?? sanitizedBase.exclusions,
    successCriteria: plan.successCriteria ?? sanitizedBase.successCriteria,
    requiredAnswerSlots: plan.requiredAnswerSlots ?? sanitizedBase.requiredAnswerSlots,
    consequentialClaims: plan.consequentialClaims ?? sanitizedBase.consequentialClaims,
  }, { query: sanitizedBase.query, depth: sanitizedBase.depth });
}
