const HOST_IN_QUERY = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|io|hk|cn|uk|jp|ai|info)\b/gi;
const FILE_EXT_HOSTS = /\.(cpp|js|ts|py|md|pdf|exe|zip|png|jpg)$/i;
const HOSTNAME_SHAPE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/;
const FILING_LIKE = /年报|半年报|招股|prospectus|10-k|10-q|年度报告|招股说明书|filing|公告/i;
const CITABLE_NUMBER = /(?:[$€£¥]|USD|CNY|HKD|RMB)?\s*\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?\s*%|\b\d{4}\b|\b\d+(?:\.\d+)?\b/;

export const EVIDENCE_CRITERIA = Object.freeze([
  'first_party',
  'filing',
  'numeric',
  'user_named',
  'mainstream_media',
]);

export const FIRST_PARTY_RETRIEVAL_TERMS = Object.freeze([
  'official',
  'blueprint',
  'repository',
  'repo',
  'github',
  'documentation',
  'docs',
]);

const CRITERIA = new Set(EVIDENCE_CRITERIA);

function unique(values = []) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function stripLeadingWww(hostname = '') {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return host.startsWith('www.') ? host.slice(4) : host;
}

function hostnameOf(url) {
  try {
    return stripLeadingWww(new URL(String(url || '')).hostname);
  } catch {
    return '';
  }
}

function hostnamesMatch(urlHostname, policyHost) {
  const left = stripLeadingWww(urlHostname);
  const right = stripLeadingWww(policyHost);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

function looksLikeHostname(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^www\./, '');
  if (!host || FILE_EXT_HOSTS.test(host)) return false;
  return HOSTNAME_SHAPE.test(host);
}

function sanitizeHosts(values = []) {
  return unique((values || [])
    .map((value) => String(value || '').trim().toLowerCase().replace(/^www\./, ''))
    .filter(looksLikeHostname));
}

export function normalizeEvidenceCriterion(value) {
  const token = String(value || '').toLowerCase().replace(/[_-\s]+/g, '');
  if (token === 'firstparty') return 'first_party';
  if (token === 'usernamed') return 'user_named';
  if (token === 'mainstreammedia') return 'mainstream_media';
  if (token === 'filing' || token === 'primaryfiling') return 'filing';
  if (token === 'numeric') return 'numeric';
  return CRITERIA.has(String(value || '').trim()) ? String(value).trim() : null;
}

export function normalizeEvidenceCriteria(values = []) {
  return unique((values || []).map(normalizeEvidenceCriterion).filter(Boolean));
}

export function gapAsksFirstParty(gap = {}) {
  return normalizeEvidenceCriteria(gap.evidenceCriteria).includes('first_party');
}

export function gapAsksFiling(gap = {}) {
  return normalizeEvidenceCriteria(gap.evidenceCriteria).includes('filing')
    || (gap.requiredSourceTypes || []).includes('primary_filing');
}

export function gapNeedsRequiredEvidence(gap = {}) {
  return Boolean(
    (gap.requiredHosts || []).length
    || gapAsksFiling(gap)
    || gapAsksFirstParty(gap),
  );
}

export function collectUserNamedHosts({
  query = '',
  brief = {},
  profile = {},
} = {}) {
  const mentioned = String(query || brief?.query || '').match(HOST_IN_QUERY) || [];
  return unique([
    ...sanitizeHosts(mentioned),
    ...sanitizeHosts(brief?.requiredHosts),
    ...(brief?.requiredAnswerSlots || []).flatMap((slot) => sanitizeHosts(slot?.requiredHosts)),
    ...sanitizeHosts(profile?.requiredHosts),
  ]);
}

function sourceIdentity(source = {}) {
  return source.sourceId || source.url || source.id || null;
}

function sourceUrl(source = {}) {
  const raw = source.sourceUrl || source.url || source.sourceId || source.id || '';
  const text = String(raw);
  return text.startsWith('body:') ? text.slice(5) : text;
}

function sourceText(source = {}) {
  return [
    source.title,
    source.url,
    source.content,
    source.summary,
    source.snippet,
    source.text,
  ].filter(Boolean).join(' ');
}

function assessmentOf(source = {}) {
  return source.assessment || {};
}

/**
 * Hard hosts only: hosts the user named or that appear literally in the query.
 * Planner-inferred preferred hosts are deliberately excluded.
 */
function hardHostsFor(extras = {}) {
  return unique([
    ...sanitizeHosts(extras.gap?.requiredHosts),
    ...(extras.userNamedHosts || collectUserNamedHosts(extras)),
  ]);
}

export function sourceSatisfiesCriterion(source = {}, criterion, extras = {}) {
  const token = normalizeEvidenceCriterion(criterion);
  if (!token || !source) return false;
  const assessment = assessmentOf(source);
  if (token === 'first_party') {
    if (assessment.firstParty === true) return true;
    // No verdict was produced, so fall back to the deterministic host rule
    // rather than treating an LLM plumbing failure as "not first party".
    if (source.assessmentStatus !== 'unavailable') return false;
    const host = hostnameOf(sourceUrl(source));
    return Boolean(host) && hardHostsFor(extras).some((item) => hostnamesMatch(host, item));
  }
  if (token === 'filing') {
    return assessment.contentKind === 'filing'
      || assessment.publisherType === 'exchange_filing'
      || FILING_LIKE.test(sourceText(source));
  }
  if (token === 'mainstream_media') {
    return assessment.publisherType === 'mainstream_media';
  }
  if (token === 'user_named') {
    const hosts = extras.userNamedHosts || collectUserNamedHosts(extras);
    const host = hostnameOf(sourceUrl(source));
    return hosts.some((item) => hostnamesMatch(host, item));
  }
  if (token === 'numeric') {
    return CITABLE_NUMBER.test(String(source.content || source.summary || source.text || ''));
  }
  return false;
}

export function officialHostCandidates(gap = {}, extras = {}) {
  return unique([
    ...sanitizeHosts(gap.requiredHosts),
    ...sanitizeHosts(gap.preferredHosts),
    ...sanitizeHosts(extras.brief?.requiredHosts),
    ...sanitizeHosts(extras.profile?.requiredHosts),
    ...sanitizeHosts(extras.profile?.preferredHosts),
    ...((extras.brief?.requiredAnswerSlots || extras.brief?.answerSlots || []).flatMap((slot) => [
      ...sanitizeHosts(slot?.requiredHosts),
      ...sanitizeHosts(slot?.preferredHosts),
    ])),
  ]);
}

export function sourceLooksOfficial(source = {}, gap = {}, extras = {}) {
  const assessment = assessmentOf(source);
  if (assessment.firstParty === true) return true;
  const host = hostnameOf(sourceUrl(source));
  if (!host) return false;
  return officialHostCandidates(gap, extras).some((item) => hostnamesMatch(host, item));
}

export function passageSatisfiesCriterion(passage = {}, criterion, extras = {}) {
  const token = normalizeEvidenceCriterion(criterion);
  if (token === 'numeric') {
    return CITABLE_NUMBER.test(String(passage.text || passage.content || ''));
  }
  return sourceSatisfiesCriterion(passage, token, extras);
}

export function evaluateEvidenceCriteria({
  gap = {},
  sources = [],
  passages = [],
  extras = {},
} = {}) {
  const required = normalizeEvidenceCriteria(gap.evidenceCriteria);
  const resolvedExtras = {
    ...extras,
    gap: extras.gap || gap,
    userNamedHosts: extras.userNamedHosts || collectUserNamedHosts(extras),
  };
  const pool = {};
  const labels = [];
  for (const criterion of required) {
    const matches = (sources || []).filter((source) => {
      if (criterion === 'numeric') {
        const sourceId = sourceIdentity(source);
        const sourcePassages = (passages || []).filter((passage) => (
          !sourceId || passage.sourceId === sourceId || passage.id === sourceId
        ));
        if (sourcePassages.length) {
          return sourcePassages.some((passage) => passageSatisfiesCriterion(passage, criterion, resolvedExtras));
        }
      }
      return sourceSatisfiesCriterion(source, criterion, resolvedExtras);
    });
    pool[criterion] = unique(matches.map(sourceIdentity));
    if (pool[criterion].length) labels.push(criterion);
  }
  const satisfied = required.filter((criterion) => (pool[criterion] || []).length > 0);
  const missing = required.filter((criterion) => !satisfied.includes(criterion));
  return {
    required,
    satisfied,
    missing,
    labels,
    pool,
  };
}

export function criterionPoolSignature(evaluation = {}) {
  const pool = evaluation.pool || {};
  return Object.fromEntries(
    Object.entries(pool)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([criterion, ids]) => [criterion, [...ids].sort()]),
  );
}

export function missingEvidenceForCriteria(evaluation = {}) {
  return (evaluation.missing || []).map((criterion) => `criterion:${criterion}`);
}
