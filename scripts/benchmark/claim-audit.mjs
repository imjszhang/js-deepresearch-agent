import { createHash } from 'node:crypto';
import {
  buildCitationMap,
  extractQualityClaims,
  getSourceEvidenceClass,
  keepNarrativeSections,
  parseCitations,
  resolveCitations,
  sourceHasFetchedBody,
} from 'js-deepresearch-engine';
import { slotPatternsHit } from './query-battery.mjs';
import {
  isWafOrErrorBody,
  registrableDomainFromUrl,
  sourceMatchesPolicy,
} from './source-policy.mjs';

export const MIN_NARRATIVE_CHARS = 200;
const CITATION_BLOCK = /\[(\d+\.\d+(?:\s*(?:[-,，])\s*\d+\.\d+)*)\]/g;
const UNIT_PATTERN = 'RMB|CNY|HKD|USD|%|％|亿|万|百万|million|billion|tok\\/s|tokens?\\/s(?:ec)?';
const LABELED_NARRATIVE_HEADING = /^(summary|executive summary|key findings|findings|摘要|总结|概述|关键发现|核心发现|主要发现)\b/i;

export function sha256Hex(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

export function extractClaimNumbers(text) {
  const stripped = String(text || '').replace(CITATION_BLOCK, ' ');
  const found = [];
  const seen = new Set();
  const pattern = new RegExp(
    `(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+\\.\\d+|20\\d{2}|\\d+)(?:\\s*(${UNIT_PATTERN}))?`,
    'gi',
  );
  for (const match of stripped.matchAll(pattern)) {
    const raw = match[1];
    const unit = match[2] || null;
    const digits = raw.replace(/,/g, '');
    const isYear = /^20\d{2}$/.test(raw);
    const isDecimal = raw.includes('.');
    const isGrouped = raw.includes(',');
    if (!unit && !isYear && !isDecimal && !isGrouped && digits.length < 2) continue;
    const key = `${digits}:${unit || ''}:${match.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ raw, digits, unit });
  }
  return found;
}

export function numbersAppearInHaystack(numbers, haystack) {
  if (!numbers.length) return 'not_applicable';
  const hay = String(haystack || '');
  const hayDigits = hay.replace(/,/g, '');
  return numbers.every((item) => {
    const digitHit = hay.includes(item.raw) || hayDigits.includes(item.digits);
    if (!digitHit) return false;
    if (!item.unit) return true;
    return hay.toLowerCase().includes(String(item.unit).toLowerCase());
  });
}

export function sourceFetchClaimedOk(source = {}) {
  return source.fetchStatus === 'ok' || source.contentOrigin === 'fetched';
}

export function sourceHasRealBody(source = {}) {
  if (!sourceHasFetchedBody(source)) return false;
  return !isWafOrErrorBody(source.content, { fetchClaimedOk: sourceFetchClaimedOk(source) });
}

export function sourceHasRealBodyOrSummary(source = {}) {
  if (sourceHasRealBody(source)) return true;
  if (getSourceEvidenceClass(source) !== 'source_summary') return false;
  return !isWafOrErrorBody(source.summary || '');
}

export function classifyAuditedSource(source = {}) {
  const content = String(source.content || '');
  if (content && isWafOrErrorBody(content, { fetchClaimedOk: sourceFetchClaimedOk(source) })) {
    return 'waf_or_error';
  }
  return getSourceEvidenceClass(source);
}

export function uniqueRegistrableDomains(sources = []) {
  const domains = [];
  const seen = new Set();
  for (const source of sources) {
    const domain = registrableDomainFromUrl(source?.url);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }
  return domains;
}

export function effectiveFindings({ findings = [], sources = [], query = '' } = {}) {
  if (Array.isArray(findings) && findings.length) return findings;
  if (Array.isArray(sources) && sources.length) return [{ question: query, sources }];
  return [];
}

export function buildAuditCitationMap({ findings = [], sources = [], query = '' } = {}) {
  return buildCitationMap(effectiveFindings({ findings, sources, query }));
}

function citationKeysOf(claim = {}) {
  const fromField = Array.isArray(claim.citationKeys) ? claim.citationKeys : [];
  return [...new Set([...fromField, ...parseCitations(claim.text || '')])];
}

function lookupSource(entry, sources = []) {
  if (!entry) return null;
  if (entry.sourceId) {
    const byId = sources.find((source) => source.id === entry.sourceId);
    if (byId) return byId;
  }
  if (entry.source?.url) {
    const byUrl = sources.find((source) => source.url === entry.source.url);
    if (byUrl) return byUrl;
  }
  return entry.source || null;
}

export function resolveClaimSources(claim, citationMap, sources = []) {
  const keys = citationKeysOf(claim);
  const { resolved, unresolved } = resolveCitations(keys, citationMap);
  const cited = [];
  const seen = new Set();
  const add = (source) => {
    if (!source) return;
    const identity = source.id || source.url;
    if (!identity || seen.has(identity)) return;
    seen.add(identity);
    cited.push(source);
  };
  for (const entry of resolved) add(lookupSource(entry, sources));
  for (const id of claim.citedSourceIds || []) {
    add(sources.find((source) => source.id === id));
  }
  return { keys, resolved, unresolved, cited };
}

export function passagesForSources(cited = [], passages = []) {
  const ids = new Set(cited.map((source) => source.id).filter(Boolean));
  const urls = new Set(cited.map((source) => source.url).filter(Boolean));
  return (passages || []).filter((passage) => ids.has(passage.sourceId) || urls.has(passage.url));
}

export function citedEvidenceHaystack(cited = [], passages = []) {
  return [
    ...cited.flatMap((source) => [source.title, source.url, source.snippet, source.summary, source.content]),
    ...passagesForSources(cited, passages).map((passage) => passage.text),
  ].filter(Boolean).join('\n');
}

export function citedBodyHaystack(cited = [], passages = []) {
  return [
    ...cited.map((source) => source.content).filter(Boolean),
    ...passagesForSources(cited, passages).map((passage) => passage.text),
  ].join('\n');
}

function firstQuote(claim = {}, passages = []) {
  const fromClaim = String(claim.quote || '').trim();
  if (fromClaim) return fromClaim;
  for (const evidence of claim.evidence || []) {
    const quote = String(evidence?.quote || '').trim();
    if (quote) return quote;
  }
  for (const passage of passages) {
    const quote = String(passage?.quote || '').trim();
    if (quote) return quote;
  }
  return null;
}

export function verifyQuoteOffsets(claim, cited = [], passages = []) {
  const quote = firstQuote(claim, passages);
  let sawFields = false;

  for (const passage of passages) {
    if (passage.contentHash) {
      sawFields = true;
      if (sha256Hex(passage.text) !== passage.contentHash) return false;
    }
    const start = passage.startChar ?? passage.start;
    const end = passage.endChar ?? passage.end;
    if (start == null || end == null) continue;
    sawFields = true;
    const source = cited.find((item) => item.id && item.id === passage.sourceId)
      || cited.find((item) => item.url && item.url === passage.url);
    const content = String(source?.content || '');
    if (!content) return false;
    const slice = content.slice(Number(start), Number(end));
    const expected = quote || passage.text;
    if (slice !== expected && !content.includes(String(passage.text || quote || ''))) return false;
  }

  for (const evidence of claim.evidence || []) {
    if (!evidence) continue;
    if (evidence.contentHash && evidence.quote) {
      sawFields = true;
      if (sha256Hex(evidence.quote) !== evidence.contentHash) return false;
    }
    const start = evidence.startChar ?? evidence.start;
    const end = evidence.endChar ?? evidence.end;
    if (start == null || end == null || !evidence.quote) continue;
    sawFields = true;
    const source = cited.find((item) => item.id && item.id === evidence.sourceId);
    const content = String(source?.content || '');
    if (content.slice(Number(start), Number(end)) !== evidence.quote) return false;
  }

  return sawFields ? true : 'not_applicable';
}

export function parseTimestamp(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function freshnessValid(cited = [], passages = [], meta = {}, maxAgeDays) {
  const createdAt = parseTimestamp(meta?.createdAt);
  const dates = [
    ...cited.flatMap((source) => [source.publishedAt, source.date, source.observedAt]),
    ...passages.map((passage) => passage.observedAt),
  ].map((value) => parseTimestamp(value)).filter((value) => value != null);
  if (!dates.length || createdAt == null) return false;
  const newest = Math.max(...dates);
  return (createdAt - newest) / 86_400_000 <= Number(maxAgeDays);
}

export function passageHashMismatches(passages = []) {
  return (passages || []).filter((passage) => (
    passage?.contentHash && passage.text != null && sha256Hex(passage.text) !== passage.contentHash
  ));
}

export function passageOffsetMismatches(passages = [], sources = []) {
  return (passages || []).filter((passage) => {
    const start = passage.startChar ?? passage.start;
    const end = passage.endChar ?? passage.end;
    if (start == null || end == null || !passage.text) return false;
    const source = sources.find((item) => item.id && item.id === passage.sourceId);
    if (!source?.content) return false;
    return source.content.slice(Number(start), Number(end)) !== passage.text;
  });
}

export function auditClaim(claim, context = {}) {
  const {
    citationMap,
    sources = [],
    passages = [],
    meta = {},
    slot = null,
    sourcePolicies = {},
  } = context;
  const { keys, unresolved, cited } = resolveClaimSources(claim, citationMap, sources);
  const citedPassages = passagesForSources(cited, passages);
  const bodyHaystack = citedBodyHaystack(cited, citedPassages);
  const citedSourceIds = claim.citedSourceIds || [];
  const missingIds = citedSourceIds.filter((id) => id && !sources.some((source) => source.id === id));
  const quote = firstQuote(claim, citedPassages);
  const numbers = extractClaimNumbers(claim.text);
  const policyEntries = slot?.sourcePolicy ? sourcePolicies[slot.sourcePolicy] : null;

  return {
    id: claim.id || null,
    text: claim.text || '',
    citation_resolved: (keys.length + citedSourceIds.length) > 0 && unresolved.length === 0 && missingIds.length === 0,
    source_body_available: cited.some((source) => sourceHasRealBody(source)),
    exact_quote_found: quote == null
      ? 'not_applicable'
      : Boolean(bodyHaystack.includes(quote) || citedPassages.some((passage) => String(passage.text || '').includes(quote))),
    quote_offsets_valid: verifyQuoteOffsets(claim, cited, citedPassages),
    numbers_match: numbers.length === 0 ? 'not_applicable' : numbersAppearInHaystack(numbers, bodyHaystack) === true,
    source_policy_match: policyEntries
      ? cited.some((source) => sourceMatchesPolicy(source.url, policyEntries))
      : 'not_applicable',
    freshness_valid: slot?.maxAgeDays != null
      ? freshnessValid(cited, citedPassages, meta, slot.maxAgeDays)
      : 'not_applicable',
    independent_corroboration_count: uniqueRegistrableDomains(cited).length,
  };
}

export function selectNarrativeClaims(claims = [], report = '', query = '') {
  const stored = (claims || []).filter((claim) => (claim.kind || 'key_claim') === 'key_claim');
  if (stored.length) {
    return stored.map((claim) => ({
      ...claim,
      citationKeys: citationKeysOf(claim),
    }));
  }
  const narrative = keepNarrativeSections(report, { query }) || String(report || '');
  return extractQualityClaims(narrative).filter((claim) => claim.kind === 'key_claim');
}

export function extractLabeledNarrative(report = '') {
  const parts = [];
  let current = null;
  for (const line of String(report || '').split('\n')) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      current = { heading: heading[2].trim(), body: [] };
      parts.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }
  return parts
    .filter((part) => LABELED_NARRATIVE_HEADING.test(part.heading))
    .map((part) => part.body.join('\n').trim())
    .filter(Boolean)
    .join('\n\n');
}

export function extractNarrativeText(report = '', query = '') {
  return keepNarrativeSections(report, { query })
    || String(report || '').split(/^##\s+(Evidence|证据)\b/im)[0]
    || '';
}

export function emptyBulletLines(report = '') {
  return String(report || '').split('\n').filter((line) => /^\s*(?:[-*]|\d+[.)])\s*$/.test(line));
}

export function headingCount(report = '') {
  return String(report || '').split('\n').filter((line) => /^#{1,6}\s+\S/.test(line)).length;
}

function check(id, pass, detail) {
  return { id, pass, detail };
}

function extractLineWindows(report = '') {
  return String(report || '').split('\n').flatMap((line) => {
    if (/^#{1,6}\s+/.test(line)) return [];
    const text = line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').replace(/^unverified:\s*/i, '').trim();
    return text.length >= 8 ? [{ text, claim: null }] : [];
  });
}

function dedupeSources(sources = []) {
  const seen = new Set();
  const unique = [];
  for (const source of sources) {
    if (!source) continue;
    const identity = source.id || source.url;
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    unique.push(source);
  }
  return unique;
}

function sourcesFromCitations(text, citationMap, sources) {
  return parseCitations(text).map((key) => lookupSource(citationMap.get(key), sources)).filter(Boolean);
}

function evaluateSlot(slot, context) {
  const {
    battery,
    report = '',
    narrative = '',
    claims = [],
    sources = [],
    passages = [],
    meta = {},
    citationMap,
  } = context;

  const atomicWindows = [
    ...claims.map((claim) => ({ text: claim.text || '', claim })),
    ...extractLineWindows(report),
  ];
  const broadWindows = slot.patternMode === 'all'
    ? []
    : [{ text: String(report || ''), claim: null }, { text: String(narrative || ''), claim: null }];
  const hitWindows = [...atomicWindows, ...broadWindows]
    .filter((window) => slotPatternsHit(window.text, slot));

  const linkedClaims = [];
  const linkedSources = [];
  for (const claim of claims) {
    const resolved = resolveClaimSources(claim, citationMap, sources);
    const haystack = citedEvidenceHaystack(resolved.cited, passages);
    if (slotPatternsHit(claim.text || '', slot) || slotPatternsHit(haystack, slot)) {
      linkedClaims.push(claim);
      linkedSources.push(...resolved.cited);
    }
  }
  for (const window of hitWindows) {
    if (window.claim) {
      linkedSources.push(...resolveClaimSources(window.claim, citationMap, sources).cited);
    } else {
      linkedSources.push(...sourcesFromCitations(window.text, citationMap, sources));
    }
  }

  const uniqueSources = dedupeSources(linkedSources);
  const uniqueUrls = [...new Set(uniqueSources.map((source) => source.url).filter(Boolean))];
  const domains = uniqueRegistrableDomains(uniqueSources);
  const policyEntries = slot.sourcePolicy ? battery.sourcePolicies?.[slot.sourcePolicy] : null;
  const patternsHit = hitWindows.length > 0 || linkedClaims.length > 0;
  const checks = [
    check('patterns_hit', patternsHit, patternsHit
      ? 'Slot patterns were found in a claim, bullet, or cited evidence window.'
      : 'Slot patterns were not found in any atomic window.'),
  ];

  const minSources = Number(slot.minSources) || 0;
  const sourcesPass = uniqueUrls.length >= minSources;
  checks.push(check('min_sources', sourcesPass, `${uniqueUrls.length} distinct cited URLs (min ${minSources}).`));

  let policyPass = true;
  if (policyEntries) {
    policyPass = uniqueSources.some((source) => sourceMatchesPolicy(source.url, policyEntries));
    checks.push(check(
      'source_policy',
      policyPass,
      policyPass ? `Cited a ${slot.sourcePolicy} host.` : `No cited URL matches source policy ${slot.sourcePolicy}.`,
    ));
  }

  if (slot.requiresNumbers) {
    const numbersPass = linkedClaims.some((claim) => (
      auditClaim(claim, { citationMap, sources, passages, meta, slot, sourcePolicies: battery.sourcePolicies }).numbers_match === true
    )) || hitWindows.some((window) => {
      const numbers = extractClaimNumbers(window.text);
      const cited = window.claim
        ? resolveClaimSources(window.claim, citationMap, sources).cited
        : sourcesFromCitations(window.text, citationMap, sources);
      return numbers.length > 0 && numbersAppearInHaystack(numbers, citedBodyHaystack(cited, passages)) === true;
    });
    checks.push(check(
      'requires_numbers',
      numbersPass,
      numbersPass ? 'Required numbers appear in cited bodies or passages.' : 'Required numbers do not appear in cited bodies or passages.',
    ));
  }

  const minDomains = Number(slot.minIndependentDomains) || 0;
  const domainsPass = domains.length >= minDomains;
  if (minDomains > 0) {
    checks.push(check(
      'independent_domains',
      domainsPass,
      `${domains.length} registrable domains (min ${minDomains}).`,
    ));
  }

  let freshnessPass = true;
  if (slot.maxAgeDays != null) {
    freshnessPass = freshnessValid(
      uniqueSources,
      passagesForSources(uniqueSources, passages),
      meta,
      slot.maxAgeDays,
    );
    checks.push(check(
      'freshness',
      freshnessPass,
      freshnessPass
        ? `Cited source date is within ${slot.maxAgeDays} days of meta.createdAt.`
        : `Missing or stale source date versus maxAgeDays ${slot.maxAgeDays}.`,
    ));
  }

  const allPass = checks.every((item) => item.pass);
  const blocked = (policyEntries && !policyPass)
    || (slot.maxAgeDays != null && !freshnessPass)
    || uniqueSources.some((source) => classifyAuditedSource(source) === 'waf_or_error');
  let status = 'missing';
  if (patternsHit && allPass) status = 'completed';
  else if (patternsHit && blocked) status = 'blocked';

  return {
    id: slot.id,
    label: slot.label || slot.id,
    required: Boolean(slot.required),
    critical: Boolean(slot.critical),
    status,
    checks,
  };
}

export function completeSlots({
  battery,
  report = '',
  narrative = '',
  claims = [],
  sources = [],
  passages = [],
  meta = {},
  citationMap,
} = {}) {
  if (!battery) {
    return { pass: true, applicable: false, slots: [] };
  }
  const map = citationMap || buildAuditCitationMap({ findings: [], sources, query: meta?.query });
  const slots = battery.slots.map((slot) => evaluateSlot(slot, {
    battery,
    report,
    narrative,
    claims,
    sources,
    passages,
    meta,
    citationMap: map,
  }));
  return {
    pass: slots.every((slot) => !slot.required || slot.status === 'completed'),
    applicable: true,
    slots,
  };
}

