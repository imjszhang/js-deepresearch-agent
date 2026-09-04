export const RESEARCH_BRIEF_SCHEMA_VERSION = 2;
export const RESEARCH_BRIEF_DEPTHS = Object.freeze(['quick', 'focused', 'exploratory']);
export const ANSWER_SLOT_PRIORITIES = Object.freeze(['critical', 'normal']);
export const REQUIRED_HOST_MODES = Object.freeze(['any', 'all']);
export const RESEARCH_QUERY_SHAPES = Object.freeze([
  'judgment',
  'inventory',
  'comparison',
  'definitional',
  'open',
]);
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

function requiredHostMode(value) {
  return REQUIRED_HOST_MODES.includes(value) ? value : 'any';
}

function sanitizeQueryShape(value) {
  const raw = String(value || '').trim().toLowerCase();
  return RESEARCH_QUERY_SHAPES.includes(raw) ? raw : null;
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseIsoDate(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  if (match[3]) {
    const day = Number(match[3]);
    if (day < 1 || day > lastDayOfMonth(year, month)) return null;
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return `${match[1]}-${match[2]}-${String(lastDayOfMonth(year, month)).padStart(2, '0')}`;
}

export function sanitizeAsOf(value, { defaultSource = 'user' } = {}) {
  if (!value) return null;
  if (typeof value === 'string') {
    const date = parseIsoDate(value);
    return date ? { date, source: defaultSource === 'planner' ? 'planner' : 'user', label: date } : null;
  }
  if (typeof value === 'object') {
    const date = parseIsoDate(value.date || value.end || value.asOf);
    if (!date) return null;
    return {
      date,
      source: value.source === 'planner' || defaultSource === 'planner' ? 'planner' : 'user',
      label: text(value.label, 80) || date,
    };
  }
  return null;
}

function extractLiteralHosts(query) {
  return sanitizeHosts(String(query || '').match(HOST_IN_QUERY) || []);
}

function slotId(value, index) {
  const normalized = text(value, 80).replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-|-$/g, '');
  return normalized || `slot-${index + 1}`;
}

function hasUserValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value != null && value !== '';
}

export function sanitizeAnswerSlots(slots, {
  query = '',
  literalHosts = [],
  allowExplicitHosts = false,
} = {}) {
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
    const hosts = sanitizeHosts(source.requiredHosts);
    const permittedRequiredHosts = allowExplicitHosts
      ? hosts
      : hosts.filter((host) => allowedHosts.has(host));
    const inferredPreferredHosts = allowExplicitHosts
      ? []
      : hosts.filter((host) => !allowedHosts.has(host));
    result.push({
      id,
      answerSlot: answerSlot || question,
      question: question || query,
      claimFamily: text(source.claimFamily || source.claimType, 120) || null,
      priority: ANSWER_SLOT_PRIORITIES.includes(source.priority) ? source.priority : 'normal',
      requiredHosts: permittedRequiredHosts,
      requiredHostMode: requiredHostMode(source.requiredHostMode),
      preferredHosts: uniqueText([
        ...sanitizeHosts(source.preferredHosts),
        ...inferredPreferredHosts,
      ]),
      requiredSourceTypes: sanitizeSourceTypes(source.requiredSourceTypes),
      successCriteria: uniqueText(source.successCriteria, 8),
      evidenceCriteria: uniqueText(source.evidenceCriteria, 8),
      requiredSlot: source.requiredSlot !== false,
    });
    if (result.length >= 20) break;
  }
  return result;
}

export function sanitizeResearchBrief(input = {}, {
  query,
  depth = 'focused',
  allowExplicitHosts = false,
} = {}) {
  const source = typeof input === 'string' ? { query: input } : (input || {});
  const resolvedQuery = text(query || source.query);
  const resolvedDepth = RESEARCH_BRIEF_DEPTHS.includes(source.depth)
    ? source.depth
    : (RESEARCH_BRIEF_DEPTHS.includes(depth) ? depth : 'focused');
  const literalHosts = extractLiteralHosts(resolvedQuery);
  const requiredAnswerSlots = sanitizeAnswerSlots(source.requiredAnswerSlots, {
    query: resolvedQuery,
    literalHosts,
    allowExplicitHosts,
  });
  return {
    schemaVersion: RESEARCH_BRIEF_SCHEMA_VERSION,
    query: resolvedQuery,
    queryShape: sanitizeQueryShape(source.queryShape),
    premise: text(source.premise) || null,
    audience: text(source.audience) || null,
    decision: text(source.decision) || null,
    assumedExpertise: text(source.assumedExpertise, 120) || null,
    timeRange: source.timeRange == null ? null : text(source.timeRange, 200),
    asOf: sanitizeAsOf(source.asOf),
    geography: uniqueText(source.geography),
    entities: uniqueText(source.entities),
    entityAliases: uniqueText(source.entityAliases),
    exclusions: uniqueText(source.exclusions),
    depth: resolvedDepth,
    deadline: source.deadline == null ? null : text(source.deadline, 120),
    successCriteria: uniqueText(source.successCriteria),
    requiredAnswerSlots,
    consequentialClaims: uniqueText(source.consequentialClaims),
    contractOrigin: text(source.contractOrigin, 40) || null,
  };
}

export function slotsFromPlannerGaps(gaps = [], { query = '' } = {}) {
  if (!Array.isArray(gaps) || !gaps.length) return [];
  return sanitizeAnswerSlots(gaps.map((gap, index) => ({
    id: gap.id,
    answerSlot: gap.answerSlot || gap.question || `slot-${index + 1}`,
    question: gap.question || gap.answerSlot,
    claimFamily: gap.claimFamily,
    priority: gap.priority,
    requiredHosts: gap.requiredHosts,
    requiredHostMode: gap.requiredHostMode,
    preferredHosts: gap.preferredHosts,
    requiredSourceTypes: gap.requiredSourceTypes,
    successCriteria: gap.successCriteria,
    evidenceCriteria: gap.evidenceCriteria,
    requiredSlot: gap.requiredSlot !== false,
  })), { query, literalHosts: extractLiteralHosts(query), allowExplicitHosts: false });
}

export function researchBriefFromInput(input, { depth = 'focused' } = {}) {
  if (typeof input === 'string') {
    return sanitizeResearchBrief({ query: input }, { depth, allowExplicitHosts: true });
  }
  return sanitizeResearchBrief(input || {}, { depth, allowExplicitHosts: true });
}

export function mergeResearchBrief(base, plan = {}, options = {}) {
  const sanitizedBase = sanitizeResearchBrief(base, {
    ...options,
    allowExplicitHosts: true,
  });
  const pickScalar = (key) => (
    hasUserValue(sanitizedBase[key]) ? sanitizedBase[key] : (plan[key] ?? sanitizedBase[key])
  );
  const pickList = (key) => (
    sanitizedBase[key]?.length ? sanitizedBase[key] : (Array.isArray(plan[key]) ? plan[key] : sanitizedBase[key])
  );
  const plannerSlots = sanitizeAnswerSlots(
    (plan.requiredAnswerSlots?.length ? plan.requiredAnswerSlots : slotsFromPlannerGaps(plan.gaps, { query: sanitizedBase.query })),
    {
      query: sanitizedBase.query,
      literalHosts: extractLiteralHosts(sanitizedBase.query),
      allowExplicitHosts: false,
    },
  );
  return sanitizeResearchBrief({
    ...sanitizedBase,
    queryShape: pickScalar('queryShape'),
    premise: pickScalar('premise'),
    audience: pickScalar('audience'),
    decision: pickScalar('decision'),
    assumedExpertise: pickScalar('assumedExpertise'),
    timeRange: pickScalar('timeRange'),
    asOf: sanitizedBase.asOf || sanitizeAsOf(plan.asOf, { defaultSource: 'planner' }),
    deadline: pickScalar('deadline'),
    geography: pickList('geography'),
    entities: pickList('entities'),
    entityAliases: pickList('entityAliases'),
    exclusions: pickList('exclusions'),
    successCriteria: pickList('successCriteria'),
    requiredAnswerSlots: sanitizedBase.requiredAnswerSlots.length
      ? sanitizedBase.requiredAnswerSlots
      : plannerSlots,
    consequentialClaims: pickList('consequentialClaims'),
    contractOrigin: sanitizedBase.contractOrigin || plan.contractOrigin || null,
  }, {
    query: sanitizedBase.query,
    depth: sanitizedBase.depth,
    allowExplicitHosts: true,
  });
}
