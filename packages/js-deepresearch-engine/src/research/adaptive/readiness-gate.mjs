import { isSuccessfulBody, sourceHasObservableDate } from '../body-quality.mjs';
import { classifyResearchQuery, subjectsMissingBodyEvidence } from './exploratory-sufficiency.mjs';
import { classifySourceTier, hostnamesMatch, independentEvidenceKeysFromSources, hostnameOf } from './source-policy.mjs';

export const GAP_OPEN_STATUSES = new Set(['open', 'searched', 'missing']);
export const GAP_CLOSED_STATUSES = new Set(['verified', 'body_read']);

function successfulSources(findings = []) {
  return findings.flatMap((finding) => (finding.sources || []).filter(isSuccessfulBody));
}

function sourcesForGap(findings, gapId) {
  return findings
    .filter((finding) => !gapId || finding.gapId === gapId)
    .flatMap((finding) => (finding.sources || []).filter(isSuccessfulBody));
}

function requiredHostsRead(gap, findings) {
  const hosts = gap.requiredHosts || [];
  const sources = sourcesForGap(findings, gap.id);
  if (!hosts.length) {
    if ((gap.requiredSourceTypes || []).includes('primary_filing')) {
      const primary = sources.filter((source) => (
        ['required_primary', 'other_primary'].includes(source.tier || classifySourceTier(source, gap))
      ));
      return {
        missing: primary.length ? [] : ['primary_filing'],
        read: primary.length ? ['primary_filing'] : [],
      };
    }
    return { missing: [], read: [] };
  }
  const read = [];
  const missing = [];
  for (const host of hosts) {
    const hit = sources.some((source) => hostnamesMatch(hostnameOf(source.url || source.id), host));
    if (hit) read.push(host);
    else missing.push(host);
  }
  return { missing, read };
}

function gapNeedsRequiredHost(gap) {
  return (gap.requiredHosts || []).length > 0 || (gap.requiredSourceTypes || []).includes('primary_filing');
}

export function evaluateReadinessGate({
  query,
  findings = [],
  gaps = [],
  profile = {},
  state = null,
} = {}) {
  const resolvedQuery = query || state?.query || '';
  const resolvedFindings = findings.length ? findings : (state?.findings || []);
  const resolvedGaps = gaps.length ? gaps : (state?.gaps || []);
  const resolvedProfile = profile.flags ? profile : (state?.profile || {});
  const shape = classifyResearchQuery(resolvedQuery);
  const failures = [];
  const flags = [];

  const bodies = successfulSources(resolvedFindings);
  if (!bodies.length) {
    failures.push({ code: 'no_successful_body', message: 'No successful real body has been read.' });
    flags.push('no_direct_evidence');
  }

  const criticalGaps = resolvedGaps.filter((gap) => gap.priority === 'critical');
  const unresolvedCritical = criticalGaps.filter((gap) => {
    if (GAP_CLOSED_STATUSES.has(gap.status) && gap.status !== 'body_read') return false;
    if (gap.status === 'verified') return false;
    const covered = sourcesForGap(resolvedFindings, gap.id).length > 0
      || (state?.gapCovered?.(gap.id) && !gapNeedsRequiredHost(gap));
    if (gap.status === 'body_read' && !gapNeedsRequiredHost(gap)) return false;
    if (gap.status === 'blocked') return true;
    if (gap.status === 'missing' || gap.status === 'open' || gap.status === 'searched') return true;
    return !covered;
  });
  if (unresolvedCritical.length) {
    failures.push({
      code: 'critical_gap_open',
      message: `Critical gaps still open: ${unresolvedCritical.map((gap) => gap.id).join(', ')}`,
      gapIds: unresolvedCritical.map((gap) => gap.id),
    });
    flags.push('critical_gaps_open');
  }

  const missingRequired = [];
  for (const gap of resolvedGaps) {
    if (!gapNeedsRequiredHost(gap)) continue;
    const { missing, read } = requiredHostsRead(gap, resolvedFindings);
    if (missing.length && !read.length) {
      missingRequired.push({ gapId: gap.id, hosts: missing });
    }
  }
  if (missingRequired.length) {
    failures.push({
      code: 'required_host_missing',
      message: 'Required primary hosts were not successfully read.',
      hosts: missingRequired.flatMap((item) => item.hosts),
    });
    flags.push('required_host_missing');
  }

  const minIndependent = Number(resolvedProfile.minIndependentSources) || (shape.kind === 'definitional' ? 1 : 2);
  const evidenceKeys = independentEvidenceKeysFromSources(bodies);
  const scope = resolvedProfile.evidenceScope || state?.evidenceScope || 'web';
  if (bodies.length && evidenceKeys.size < minIndependent && minIndependent > 1) {
    const label = scope === 'local' ? 'independent local corpora' : 'independent domains';
    failures.push({
      code: 'independent_sources_short',
      message: `Need ${minIndependent} ${label}, found ${evidenceKeys.size}.`,
    });
    flags.push('reprint_concentration');
  }

  const missingSubjects = shape.kind === 'comparison'
    ? subjectsMissingBodyEvidence(resolvedFindings.filter((finding) => (
      (finding.sources || []).some(isSuccessfulBody)
    )), shape.subjects)
    : [];
  if (missingSubjects.length) {
    failures.push({
      code: 'comparison_incomplete',
      message: `Missing body evidence for: ${missingSubjects.join(', ')}`,
    });
    flags.push('comparison_coverage_incomplete');
  }

  if (resolvedProfile.flags?.freshness || /\b(latest|current|today|recent|as of)\b|目前|当前|最新|截至/i.test(resolvedQuery)) {
    const dated = bodies.some((source) => sourceHasObservableDate(source));
    if (!dated && resolvedProfile.flags?.freshness) {
      failures.push({ code: 'freshness_unknown', message: 'Freshness was required but no dated source body was read.' });
      flags.push('freshness_unknown');
    }
  }

  const pass = failures.length === 0;
  return {
    pass,
    failures,
    flags,
    independentDomainCount: evidenceKeys.size,
    independentEvidenceCount: evidenceKeys.size,
    successfulBodyCount: bodies.length,
    unresolvedCriticalGapIds: unresolvedCritical.map((gap) => gap.id),
    missingRequiredHosts: missingRequired.flatMap((item) => item.hosts),
    missingSubjects,
    method: 'rules',
    decision: pass ? 'finalize' : 'continue',
  };
}

export function repairGapsFromGate() {
  return [];
}

export function describeUnresolvedGaps(gaps = []) {
  return (gaps || [])
    .filter((gap) => !GAP_CLOSED_STATUSES.has(gap.status) || (
      gap.status === 'body_read'
      && ((gap.requiredHosts || []).length || (gap.requiredSourceTypes || []).includes('primary_filing'))
    ))
    .filter((gap) => ['open', 'searched', 'missing', 'blocked', 'body_read'].includes(gap.status) && (
      gap.priority === 'critical'
      || gap.status === 'blocked'
      || gap.status === 'missing'
      || (gap.requiredHosts || []).length
      || (gap.requiredSourceTypes || []).includes('primary_filing')
    ));
}
