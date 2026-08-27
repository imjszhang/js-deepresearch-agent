import { isSuccessfulBody } from './body-quality.mjs';
import { hostMatchesAny, hostnameOf } from './hostname-policy.mjs';
import { independentBodyDomains, isPrimaryTier, classifySourceTier } from './source-policy.mjs';

export const GAP_STATUSES = Object.freeze([
  'open',
  'searched',
  'body_read',
  'verified',
  'blocked',
  'missing',
]);

const REQUIRED_UNMET = new Set(['open', 'searched', 'body_read', 'missing', 'blocked']);

function successfulSources(findings = [], gapId = null) {
  return findings.flatMap((finding) => {
    if (gapId && finding.gapId && finding.gapId !== gapId) return [];
    return (finding.sources || []).filter(isSuccessfulBody);
  });
}

function gapBodies(gap, findings = []) {
  const fromGapReads = (gap.readSourceIds || [])
    .map((id) => findings.flatMap((finding) => finding.sources || []).find((source) => (source.id || source.url) === id))
    .filter(isSuccessfulBody);
  if (fromGapReads.length) return fromGapReads;
  return successfulSources(findings, gap.id);
}

export function isRequiredOrCriticalGap(gap = {}) {
  return gap.priority === 'critical'
    || Boolean(gap.requiredHosts?.length)
    || (gap.requiredSourceTypes || []).includes('primary');
}

export function gapHasRequiredPrimary(gap, sources = []) {
  const requiredHosts = gap.requiredHosts || [];
  if (!requiredHosts.length) {
    if (!(gap.requiredSourceTypes || []).includes('primary')) return true;
    return sources.some((source) => isPrimaryTier(classifySourceTier(source, gap)));
  }
  return sources.some((source) => hostMatchesAny(hostnameOf(source.url || source.id), requiredHosts));
}

export function gapEvidenceMeetsContract(gap, findings = []) {
  const sources = gapBodies(gap, findings);
  const minIndependent = Math.max(1, Number(gap.minIndependentSources) || 1);
  const domains = independentBodyDomains(sources);
  const needsPrimary = Boolean(gap.requiredHosts?.length) || (gap.requiredSourceTypes || []).includes('primary');
  if (!sources.length) return false;
  if (needsPrimary && !gapHasRequiredPrimary(gap, sources)) return false;
  if (domains.size < minIndependent) return false;
  return true;
}

export function evaluateGapReadiness(gap, findings = []) {
  const sources = gapBodies(gap, findings);
  const failures = [];
  const minIndependent = Math.max(1, Number(gap.minIndependentSources) || 1);
  const domains = independentBodyDomains(sources);
  const needsPrimary = Boolean(gap.requiredHosts?.length) || (gap.requiredSourceTypes || []).includes('primary');
  const required = isRequiredOrCriticalGap(gap);
  const status = gap.status || 'open';
  const evidenceClosed = gapEvidenceMeetsContract(gap, findings);

  if (status === 'blocked' && required && !evidenceClosed) {
    failures.push({
      code: 'required_source_blocked',
      gapId: gap.id,
      repairQuestion: gap.question,
      requiredHosts: gap.requiredHosts || [],
    });
  }
  if (status === 'missing' && required) {
    failures.push({
      code: 'required_gap_missing',
      gapId: gap.id,
      repairQuestion: gap.question,
      requiredHosts: gap.requiredHosts || [],
      requiredSourceTypes: gap.requiredSourceTypes || [],
    });
  }
  if (required && !evidenceClosed) {
    failures.push({
      code: 'required_gap_unresolved',
      gapId: gap.id,
      repairQuestion: gap.question,
      requiredHosts: gap.requiredHosts || [],
      requiredSourceTypes: gap.requiredSourceTypes || [],
    });
  }
  if (needsPrimary && !gapHasRequiredPrimary(gap, sources)) {
    failures.push({
      code: 'required_primary_missing',
      gapId: gap.id,
      repairQuestion: `Find a primary source for: ${gap.question}`,
      requiredHosts: gap.requiredHosts || [],
      requiredSourceTypes: gap.requiredSourceTypes || ['primary'],
    });
  }
  if (sources.length && domains.size < minIndependent) {
    failures.push({
      code: 'independent_sources_short',
      gapId: gap.id,
      repairQuestion: `Find an independent source for: ${gap.question}`,
      requiredHosts: gap.requiredHosts || [],
    });
  }
  if (needsPrimary && (gap.requiredHosts || []).length && !sources.some((source) => (
    hostMatchesAny(hostnameOf(source.url || source.id), gap.requiredHosts)
  ))) {
    failures.push({
      code: 'required_host_unread',
      gapId: gap.id,
      repairQuestion: `Read ${gap.requiredHosts.join(' or ')} for: ${gap.question}`,
      requiredHosts: gap.requiredHosts,
    });
  }
  return {
    gapId: gap.id,
    pass: failures.length === 0 && evidenceClosed,
    failures,
    bodyCount: sources.length,
    independentDomains: [...domains],
    evidenceClosed,
  };
}

export function evaluateReadinessGate({
  query = '',
  profile = null,
  gaps = [],
  findings = [],
  llmPass = null,
  missingSubjects = [],
} = {}) {
  const flags = [];
  const failures = [];
  const bodies = successfulSources(findings);
  if (!bodies.length) {
    flags.push('no_successful_body');
    failures.push({
      code: 'no_successful_body',
      gapId: gaps[0]?.id || 'gap-1',
      repairQuestion: query,
    });
  }

  if (missingSubjects.length) {
    flags.push('comparison_coverage_incomplete');
    for (const subject of missingSubjects) {
      failures.push({
        code: 'comparison_subject_missing',
        gapId: gaps[0]?.id || 'gap-1',
        repairQuestion: `Read a body-level source about ${subject}`,
      });
    }
  }

  if (profile?.requirements?.freshness) {
    const dated = bodies.some((source) => source.publishedAt || source.date || source.updatedAt);
    if (!dated) {
      flags.push('freshness_unknown');
      failures.push({
        code: 'freshness_unknown',
        gapId: gaps[0]?.id || 'gap-1',
        repairQuestion: `${query} official publication date`,
      });
    }
  }

  if (profile?.requirements?.numeric) {
    const hasNumber = bodies.some((source) => /\d/.test(`${source.content || ''} ${source.summary || ''}`));
    if (!hasNumber) {
      flags.push('numeric_evidence_missing');
      failures.push({
        code: 'numeric_evidence_missing',
        gapId: gaps[0]?.id || 'gap-1',
        repairQuestion: `Find a cited numeric figure for: ${query}`,
      });
    }
  }

  for (const gap of gaps) {
    const result = evaluateGapReadiness(gap, findings);
    failures.push(...result.failures);
    if (!result.pass && isRequiredOrCriticalGap(gap) && REQUIRED_UNMET.has(gap.status || 'open')) {
      flags.push('required_gap_unresolved');
    }
  }

  const uniqueFailures = [];
  const seen = new Set();
  for (const failure of failures) {
    const key = `${failure.code}:${failure.gapId}:${failure.repairQuestion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueFailures.push(failure);
  }

  const deterministicPass = uniqueFailures.length === 0;
  // LLM may explain misses or propose repairs, but it cannot flip a failed gate.
  const pass = deterministicPass;
  if (llmPass === true && !deterministicPass) flags.push('llm_override_ignored');
  if (llmPass === false && deterministicPass) flags.push('llm_requested_more_evidence');

  const blockedRequired = gaps.some((gap) => isRequiredOrCriticalGap(gap) && gap.status === 'blocked');
  const openRequired = gaps.some((gap) => (
    isRequiredOrCriticalGap(gap) && ['open', 'searched', 'missing', 'body_read'].includes(gap.status || 'open')
  ));

  return {
    pass,
    deterministicPass,
    llmPass,
    flags: [...new Set(flags)],
    failures: uniqueFailures,
    blockedRequired,
    openRequired,
    successfulBodyCount: bodies.length,
    decision: pass
      ? 'stop'
      : (blockedRequired && !openRequired ? 'source_blocked' : 'continue'),
    method: 'rules',
  };
}

export function repairGapsFromGate(gate, existingGaps = []) {
  return (gate?.failures || [])
    .map((failure) => ({
      question: String(failure.repairQuestion || '').trim(),
      priority: 'critical',
      requiredHosts: failure.requiredHosts || [],
      requiredSourceTypes: failure.requiredSourceTypes || [],
      repairOf: failure.gapId || null,
    }))
    .filter((item) => item.question)
    .filter((item) => !(existingGaps || []).some((gap) => (
      String(gap.question || '').trim().toLowerCase() === item.question.toLowerCase()
    )));
}
