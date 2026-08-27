import { isRequiredOrCriticalGap } from './readiness-gate.mjs';
import { classifySourceTier, isPrimaryTier } from './source-policy.mjs';
import { isSuccessfulBody } from './body-quality.mjs';
import { hostnameOf } from './hostname-policy.mjs';

const OPEN_STATUSES = new Set(['open', 'searched', 'body_read', 'missing', 'blocked']);

export function collectUnresolvedGaps(gaps = []) {
  return (gaps || []).filter((gap) => OPEN_STATUSES.has(gap.status || 'open'));
}

export function collectBlockedHosts(gaps = [], candidates = new Map()) {
  const hosts = new Set(gaps.flatMap((gap) => gap.blockedHosts || []));
  for (const candidate of candidates.values?.() || []) {
    if (candidate.status === 'waf' || candidate.status === 'failed') {
      if (candidate.hostname) hosts.add(candidate.hostname);
    }
  }
  return [...hosts];
}

export function collectSecondaryOnlyClaims(findings = [], gaps = []) {
  const required = (gaps || []).filter((gap) => (gap.requiredHosts || []).length || (gap.requiredSourceTypes || []).includes('primary'));
  if (!required.length) return [];
  const notes = [];
  for (const gap of required) {
    const sources = findings
      .filter((finding) => finding.gapId === gap.id)
      .flatMap((finding) => finding.sources || [])
      .filter(isSuccessfulBody);
    if (!sources.length) continue;
    const hasPrimary = sources.some((source) => isPrimaryTier(classifySourceTier(source, gap)));
    if (!hasPrimary) {
      notes.push(`${gap.question} currently has only secondary or reprint bodies (${sources.map((source) => hostnameOf(source.url)).filter(Boolean).join(', ') || 'unknown hosts'}).`);
    }
  }
  return notes;
}

export function buildForcedReportLimitations({
  stopReason,
  gaps = [],
  findings = [],
  candidates = new Map(),
  profile = null,
} = {}) {
  const unresolved = collectUnresolvedGaps(gaps);
  const blockedHosts = collectBlockedHosts(gaps, candidates);
  const secondaryOnly = collectSecondaryOnlyClaims(findings, gaps);
  const limitations = [];

  if (unresolved.length) {
    limitations.push(`Unresolved gaps: ${unresolved.map((gap) => `${gap.id} (${gap.status || 'open'}: ${gap.question})`).join('; ')}.`);
  }
  if (blockedHosts.length) {
    limitations.push(`Blocked or unreadable hosts: ${blockedHosts.join(', ')}.`);
  }
  if (secondaryOnly.length) {
    limitations.push(`Secondary-only claims: ${secondaryOnly.join(' ')}`);
  }
  const criticalOpen = unresolved.filter(isRequiredOrCriticalGap);
  if (criticalOpen.length || stopReason === 'source_blocked' || profile?.requirements?.decision_critical) {
    limitations.push('This report cannot support a decision that requires the unread or blocked primary evidence listed above.');
  }
  if (stopReason === 'budget_exhausted') {
    limitations.push('Exploration budget was exhausted before the evidence gate passed; treat remaining open gaps as unresolved.');
  }
  if (stopReason === 'source_blocked') {
    limitations.push('Required primary sources could not be discovered or read, so evidence is not sufficient.');
  }
  if (stopReason === 'safety_cap') {
    limitations.push('A safety cap stopped exploration before every required gap was verified.');
  }
  return [...new Set(limitations)];
}

export function attachExploratoryController(findings, controller) {
  const list = Array.isArray(findings) ? findings : [];
  Object.defineProperty(list, 'exploratoryController', {
    value: controller,
    enumerable: false,
    configurable: true,
  });
  return list;
}
