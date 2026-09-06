import { isSuccessfulBody, sourceHasObservableDate } from '../body-quality.mjs';
import {
  classifySourceTier,
  documentMatchesQuerySubject,
  hostnameOf,
  hostnamesMatch,
  independentEvidenceKeysFromSources,
  requiredHostCoverage,
} from './source-policy.mjs';
import { hasUsableResearchContract } from './research-profile.mjs';
import { evaluateEvidenceCriteria, gapNeedsRequiredEvidence } from '../evidence-criteria.mjs';
import { collectGapSources, evidenceStatusOf, isRepairTerminal, isRequiredSlot } from '../gap-state.mjs';

export const GAP_OPEN_STATUSES = new Set(['open', 'searched', 'missing', 'conflicting', 'limited', 'body_read']);
export const GAP_CLOSED_STATUSES = new Set(['verified']);

function successfulSources(findings = []) {
  return findings.flatMap((finding) => (finding.sources || []).filter(isSuccessfulBody));
}

/**
 * Why a required host has no usable body. "Fetched but rejected" and "never
 * retrieved" call for different repairs, so they must not share one message.
 */
function hostAttemptDiagnostics(hosts = [], findings = []) {
  const attempts = findings.flatMap((finding) => finding.sources || []);
  return hosts.map((host) => {
    const forHost = attempts.filter((source) => hostnamesMatch(hostnameOf(source?.url || source?.id), host));
    if (!forHost.length) return { host, reason: 'not_retrieved' };
    if (forHost.some((source) => source.fetchStatus === 'ok')) {
      const rejected = forHost.find((source) => source.fetchStatus === 'ok');
      return {
        host,
        reason: 'body_rejected',
        bodyQuality: rejected.bodyQuality || null,
        assessmentStatus: rejected.assessmentStatus || null,
        detail: rejected.skipReason || rejected.accessNotes || null,
      };
    }
    const blocked = forHost[0];
    return {
      host,
      reason: 'fetch_blocked',
      detail: blocked.fetchErrorType || blocked.fetchError || null,
      httpStatus: blocked.httpStatus ?? null,
    };
  });
}

function hostFailureMessage(diagnostics = []) {
  const rejected = diagnostics.filter((item) => item.reason === 'body_rejected');
  const blocked = diagnostics.filter((item) => item.reason === 'fetch_blocked');
  if (rejected.length && !blocked.length && rejected.length === diagnostics.length) {
    return 'Required primary hosts were retrieved but no body passed the evidence checks.';
  }
  if (blocked.length && blocked.length === diagnostics.length) {
    return 'Required primary hosts refused the request and were never retrieved.';
  }
  return 'Required primary hosts were not successfully read.';
}

function requiredHostsRead(gap, findings, extras = {}) {
  const hosts = gap.requiredHosts || [];
  const pool = collectGapSources(gap, findings);
  if (!hosts.length) {
    if ((gap.requiredSourceTypes || []).includes('primary_filing')) {
      const primary = pool.filter((source) => (
        ['required_primary', 'other_primary'].includes(source.tier || classifySourceTier(source, gap))
        && documentMatchesQuerySubject(source, extras.query || gap.question, extras)
      ));
      return {
        missing: primary.length ? [] : ['primary_filing'],
        read: primary.length ? ['primary_filing'] : [],
        satisfied: primary.length > 0,
      };
    }
    return { missing: [], read: [], satisfied: true };
  }
  return requiredHostCoverage(pool, gap);
}

function gapNeedsRequiredHost(gap) {
  return gapNeedsRequiredEvidence(gap);
}

function requiredEvidenceRead(gap, findings, extras = {}) {
  const hosts = requiredHostsRead(gap, findings, extras);
  const pool = collectGapSources(gap, findings);
  const criteria = evaluateEvidenceCriteria({
    gap,
    sources: pool,
    extras,
  });
  return {
    missing: [...(hosts.missing || []), ...criteria.missing.map((item) => `criterion:${item}`)],
    read: [...(hosts.read || []), ...criteria.satisfied],
    satisfied: hosts.satisfied === true && criteria.missing.length === 0,
  };
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
  const brief = resolvedProfile.brief || state?.brief || {};
  for (const slot of brief.requiredAnswerSlots || []) {
    const matches = resolvedGaps.filter((gap) => (
      isRequiredSlot(gap)
      && (gap.contractSlotId === slot.id
        || (!gap.contractSlotId && gap.answerSlot === slot.answerSlot))
    ));
    if (!matches.length) {
      failures.push({
        code: 'contract_slot_missing',
        message: `Required contract slot was not materialized: ${slot.id}.`,
        slotId: slot.id,
      });
      flags.push('contract_slot_missing');
    } else if (matches.length > 1) {
      failures.push({
        code: 'contract_slot_duplicate',
        message: `Required contract slot was materialized more than once: ${slot.id}.`,
        slotId: slot.id,
        gapIds: matches.map((gap) => gap.id),
      });
      flags.push('contract_slot_duplicate');
    }
  }

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
  const unresolvedCritical = criticalGaps.filter((gap) => !GAP_CLOSED_STATUSES.has(evidenceStatusOf(gap)));
  if (unresolvedCritical.length) {
    failures.push({
      code: 'critical_gap_open',
      message: `Critical gaps still open: ${unresolvedCritical.map((gap) => gap.id).join(', ')}`,
      gapIds: unresolvedCritical.map((gap) => gap.id),
    });
    flags.push('critical_gaps_open');
  }

  const unresolvedRequiredSlots = resolvedGaps.filter((gap) => (
    isRequiredSlot(gap) && !GAP_CLOSED_STATUSES.has(evidenceStatusOf(gap))
  ));
  if (unresolvedRequiredSlots.length) {
    const missingCriteria = unresolvedRequiredSlots.flatMap((gap) => (
      (gap.missingEvidence || []).filter((item) => String(item).startsWith('criterion:'))
    ));
    const semanticOpen = unresolvedRequiredSlots.filter((gap) => (
      (gap.missingEvidence || []).includes('slot_support')
      || (gap.missingEvidence || []).includes('slot_partial')
    ));
    const quoteOpen = unresolvedRequiredSlots.filter((gap) => (
      gap.slotSupport && gap.slotSupport.quoteAnchored !== true
    ));
    failures.push({
      code: 'required_slot_open',
      message: `Required answer slots still open: ${unresolvedRequiredSlots.map((gap) => gap.id).join(', ')}`,
      gapIds: unresolvedRequiredSlots.map((gap) => gap.id),
      missingEvidence: unresolvedRequiredSlots.flatMap((gap) => gap.missingEvidence || []),
    });
    flags.push('required_slots_open');
    if (missingCriteria.length) flags.push('required_evidence_missing');
    if (semanticOpen.length) flags.push('slot_semantic_unsupported');
    if (quoteOpen.length) flags.push('slot_quote_unanchored');
  }

  const missingRequired = [];
  const extras = {
    query: state?.query,
    entities: brief.entities || [],
    entityAliases: brief.entityAliases || [],
    brief,
    profile: resolvedProfile,
  };
  for (const gap of resolvedGaps) {
    if (gap.rollup || !gapNeedsRequiredHost(gap)) continue;
    const coverage = requiredEvidenceRead(gap, resolvedFindings, extras);
    if (coverage.missing.length && !coverage.satisfied) {
      const { missing } = coverage;
      missingRequired.push({ gapId: gap.id, hosts: missing });
    }
  }
  if ((resolvedProfile.requiredHosts || []).length) {
    const globalCoverage = requiredHostCoverage(bodies, resolvedProfile);
    if (!globalCoverage.satisfied) {
      missingRequired.push({ gapId: 'profile', hosts: globalCoverage.missing });
    }
  }
  if (missingRequired.length) {
    const hosts = missingRequired.flatMap((item) => item.hosts);
    const hostDiagnostics = hostAttemptDiagnostics(
      hosts.filter((host) => !String(host).startsWith('criterion:') && host !== 'primary_filing'),
      resolvedFindings,
    );
    failures.push({
      code: 'required_host_missing',
      message: hostFailureMessage(hostDiagnostics),
      hosts,
      hostDiagnostics,
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

  const unresolvedRequiredGapIds = unresolvedRequiredSlots.map((gap) => gap.id);
  const unresolvedCriticalGapIds = unresolvedCritical.map((gap) => gap.id);
  const repairGapIds = uniqueIds([
    ...unresolvedCriticalGapIds,
    ...unresolvedRequiredGapIds,
    ...resolvedGaps
      .filter((gap) => !gap.rollup && ['conflicting', 'limited', 'body_read'].includes(evidenceStatusOf(gap)))
      .map((gap) => gap.id),
  ]);
  const pass = failures.length === 0;
  return {
    pass,
    failures,
    flags,
    independentDomainCount: evidenceKeys.size,
    independentEvidenceCount: evidenceKeys.size,
    successfulBodyCount: bodies.length,
    unresolvedCriticalGapIds,
    unresolvedRequiredGapIds,
    repairGapIds,
    missingRequiredHosts: missingRequired.flatMap((item) => item.hosts),
    missingSubjects: [],
    method: 'rules',
    decision: pass ? 'finalize' : 'continue',
  };
}

function uniqueIds(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

export function repairGapsFromGate(gate = {}, gaps = []) {
  const targetIds = new Set([
    ...(gate.unresolvedCriticalGapIds || []),
    ...(gate.unresolvedRequiredGapIds || []),
    ...(gate.repairGapIds || []),
    ...(gate.failures || []).flatMap((failure) => failure.gapIds || []),
  ]);
  return gaps.filter((gap) => {
    if (gap.rollup) return false;
    if (isRepairTerminal(gap)) return false;
    return targetIds.has(gap.id)
      || ['conflicting', 'limited', 'body_read'].includes(evidenceStatusOf(gap))
      || (gap.priority === 'critical' && GAP_OPEN_STATUSES.has(evidenceStatusOf(gap)))
      || (isRequiredSlot(gap) && !GAP_CLOSED_STATUSES.has(evidenceStatusOf(gap)));
  });
}

export function describeUnresolvedGaps(gaps = []) {
  return (gaps || [])
    .filter((gap) => !gap.rollup)
    .filter((gap) => !GAP_CLOSED_STATUSES.has(evidenceStatusOf(gap)))
    .filter((gap) => (
      gap.priority === 'critical'
      || isRequiredSlot(gap)
      || isRepairTerminal(gap)
      || gap.status === 'missing'
      || gapNeedsRequiredEvidence(gap)
    ));
}
