function unique(values = []) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function countBy(items, keyOf) {
  const counts = {};
  for (const item of items || []) {
    const key = keyOf(item);
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export function collectObservabilityMetrics({
  findings = [],
  trace = [],
  searchOutcomes = [],
  agentSnapshotChars = null,
} = {}) {
  const sources = (findings || []).flatMap((finding) => finding.sources || []);
  const assessments = sources.map((source) => source.assessment).filter(Boolean);
  const slotTraces = (trace || []).filter((entry) => entry.action === 'slot_support');
  const searchTraces = (trace || []).filter((entry) => entry.action === 'search');
  const respondedEngines = unique(searchTraces.flatMap((entry) => entry.respondedEngines || []));
  const unresponsiveEngines = unique(searchTraces.flatMap((entry) => entry.unresponsiveEngines || []));
  const outcomes = countBy(
    [...searchTraces, ...(searchOutcomes || [])],
    (item) => item.outcome,
  );
  return {
    respondedEngines: respondedEngines.length ? respondedEngines : null,
    unresponsiveEngines: unresponsiveEngines.length ? unresponsiveEngines : null,
    queryOutcomes: Object.keys(outcomes).length ? outcomes : null,
    sourceAssessment: assessments.length ? {
      count: assessments.length,
      readability: countBy(assessments, (item) => item.readability),
      publisherType: countBy(assessments, (item) => item.publisherType),
      evidenceTier: countBy(assessments, (item) => item.evidenceTier),
      failClosed: assessments.filter((item) => item.method === 'fail_closed').length,
    } : null,
    slotSupportCache: slotTraces.some((entry) => entry.cacheHits != null || entry.cacheMisses != null) ? {
      hits: slotTraces.reduce((sum, entry) => sum + (Number(entry.cacheHits) || 0), 0),
      misses: slotTraces.reduce((sum, entry) => sum + (Number(entry.cacheMisses) || 0), 0),
    } : null,
    agentSnapshotChars: Number.isFinite(Number(agentSnapshotChars)) ? Number(agentSnapshotChars) : null,
  };
}
