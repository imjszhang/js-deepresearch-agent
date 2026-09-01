import { isSuccessfulBody, sourceHasObservableDate } from '../body-quality.mjs';
import { classifySourceTier, hostnamesMatch, independentEvidenceKeysFromSources, hostnameOf } from './source-policy.mjs';
import { hasUsableResearchContract } from './research-profile.mjs';
import { collectGapSources, isRequiredSlot } from '../gap-state.mjs';

export const GAP_OPEN_STATUSES = new Set(['open', 'searched', 'missing', 'conflicting', 'limited', 'body_read']);
export const GAP_CLOSED_STATUSES = new Set(['verified']);

function successfulSources(findings = []) {
  return findings.flatMap((finding) => (finding.sources || []).filter(isSuccessfulBody));
}

function requiredHostsRead(gap, findings) {
  const hosts = gap.requiredHosts || [];
  const pool = collectGapSources(gap, findings);
  if (!hosts.length) {
    if ((gap.requiredSourceTypes || []).includes('primary_filing')) {
      const primary = pool.filter((source) => (
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
    const hit = pool.some((source) => hostnamesMatch(hostnameOf(source.url || source.id), host));
    if (hit) read.push(host);
    else missing.push(host);
  }
  return { missing, read };
}

function gapNeedsRequiredHost(gap) {
  return (gap.requiredHosts || []).length > 0 || (gap.requiredSourceTypes || []).includes('primary_filing');
}

export function evaluateReadinessGate({
  findings = [],
  gaps = [],
  profile = {},
  state = null,
} = {}) {
  const resolvedFindings = findings.length ? findings : (state?.findings || []);
  const resolvedGaps = gaps.length ? gaps : (state?.gaps || []);
  const resolvedProfile = profile.flags || profile.requiredHosts || profile.contractUnavailable != null
    ? profile
    : (state?.profile || {});
  const failures = [];
  const flags = [];

  if (resolvedProfile.contractUnavailable) {
    failures.push({
      code: 'contract_unavailable',
      message: resolvedProfile.contractFailure
        ? `Research contract is unavailable (${resolvedProfile.contractFailure}).`
        : 'Research contract is unavailable; required slots were not planned.',
    });
    flags.push('contract_unavailable');
  } else if (!hasUsableResearchContract(resolvedProfile, resolvedProfile.brief || state?.brief || {})
    && !resolvedGaps.some(isRequiredSlot)
    && !(resolvedProfile.requiredHosts || []).length
    && !(resolvedProfile.requiredSourceTypes || []).length) {
    // Root-only runs still need a planned or user contract before evidence_sufficient.
    if (!resolvedGaps.some((gap) => isRequiredSlot(gap))) {
      const root = resolvedGaps.find((gap) => gap.kind === 'root' && !gap.rollup);
      if (root && root.status !== 'verified') {
        failures.push({
          code: 'contract_unavailable',
          message: 'No dynamic required slots were available to verify.',
        });
        flags.push('contract_unavailable');
      }
    }
  }

  const bodies = successfulSources(resolvedFindings);
  if (!bodies.length) {
    failures.push({ code: 'no_successful_body', message: 'No successful real body has been read.' });
    flags.push('no_direct_evidence');
  }

  const criticalGaps = resolvedGaps.filter((gap) => gap.priority === 'critical' && !gap.rollup);
  const unresolvedCritical = criticalGaps.filter((gap) => !GAP_CLOSED_STATUSES.has(gap.status));
  if (unresolvedCritical.length) {
    failures.push({
      code: 'critical_gap_open',
      message: `Critical gaps still open: ${unresolvedCritical.map((gap) => gap.id).join(', ')}`,
      gapIds: unresolvedCritical.map((gap) => gap.id),
    });
    flags.push('critical_gaps_open');
  }

  const unresolvedRequiredSlots = resolvedGaps.filter((gap) => (
    isRequiredSlot(gap) && !GAP_CLOSED_STATUSES.has(gap.status)
  ));
  if (unresolvedRequiredSlots.length) {
    failures.push({
      code: 'required_slot_open',
      message: `Required answer slots still open: ${unresolvedRequiredSlots.map((gap) => gap.id).join(', ')}`,
      gapIds: unresolvedRequiredSlots.map((gap) => gap.id),
    });
    flags.push('required_slots_open');
  }

  const missingRequired = [];
  for (const gap of resolvedGaps) {
    if (gap.rollup || !gapNeedsRequiredHost(gap)) continue;
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

  const minIndependent = Number(resolvedProfile.minIndependentSources) || 1;
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

  if (resolvedProfile.flags?.freshness) {
    const dated = bodies.some((source) => sourceHasObservableDate(source));
    if (!dated) {
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
    missingSubjects: [],
    method: 'rules',
    decision: pass ? 'finalize' : 'continue',
  };
}

export function repairGapsFromGate(gate = {}, gaps = []) {
  const targetIds = new Set([
    ...(gate.unresolvedCriticalGapIds || []),
    ...(gate.failures || []).flatMap((failure) => failure.gapIds || []),
  ]);
  return gaps.filter((gap) => {
    if (gap.rollup) return false;
    return targetIds.has(gap.id)
      || ['conflicting', 'limited', 'body_read'].includes(gap.status)
      || (gap.priority === 'critical' && GAP_OPEN_STATUSES.has(gap.status))
      || (isRequiredSlot(gap) && !GAP_CLOSED_STATUSES.has(gap.status));
  });
}

export function describeUnresolvedGaps(gaps = []) {
  return (gaps || [])
    .filter((gap) => !gap.rollup)
    .filter((gap) => !GAP_CLOSED_STATUSES.has(gap.status))
    .filter((gap) => (
      gap.priority === 'critical'
      || isRequiredSlot(gap)
      || gap.status === 'blocked'
      || gap.status === 'missing'
      || (gap.requiredHosts || []).length
      || (gap.requiredSourceTypes || []).includes('primary_filing')
    ));
}
