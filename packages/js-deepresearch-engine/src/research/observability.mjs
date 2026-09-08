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

export function collectTransportMetrics({ findings = [], transportMemory = null } = {}) {
  const sources = (findings || []).flatMap((finding) => finding.sources || []);
  const facts = typeof transportMemory?.plannerFacts === 'function'
    ? transportMemory.plannerFacts()
    : { blockedHosts: [], attemptedUrls: [] };
  const fetchBlocked = countBy(
    sources.filter((source) => source.fetchStatus && source.fetchStatus !== 'ok'),
    (source) => source.fetchErrorType || source.errorType || source.accessStatus || 'failed',
  );
  return {
    fetchAttempted: sources.filter((source) => source.fetchStatus || source.fetchAttempts).length,
    fetchOk: sources.filter((source) => source.fetchStatus === 'ok').length,
    fetchBlocked: Object.keys(fetchBlocked).length ? fetchBlocked : null,
    backendEscalations: sources.filter((source) => source.retrievedVia && source.retrievedVia !== 'direct').length,
    blockedHosts: facts.blockedHosts || [],
  };
}

export function collectObservabilityMetrics({
  findings = [],
  trace = [],
  searchOutcomes = [],
  agentSnapshotChars = null,
  transportMemory = null,
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
    transport: collectTransportMetrics({ findings, transportMemory }),
  };
}

export function collectCanonicalObservability({ findings = [], trace = [], sourceReadAttempts = null, previous = null } = {}) {
  const snapshots = new Map();
  for (const finding of findings) {
    if (finding.origin === 'document_reuse') continue;
    for (const source of finding.sources || []) {
      const key = JSON.stringify([source.finalUrl || source.url || source.id, source.retrievedAt || null,
        source.documentVersionId || source.contentSha256 || null, source.fetchStatus || null, source.backend || null]);
      if (!snapshots.has(key)) snapshots.set(key, source);
    }
  }
  const result = collectObservabilityMetrics({ findings: [{ sources: [...snapshots.values()] }], trace });
  // These are source snapshots, not HTTP attempts: a read may retry or use cache.
  result.transport = { ...result.transport, scope: 'unique_retrieval_snapshots', sourceReadAttempts,
    blockedHosts: previous?.transport?.blockedHosts || [] };
  if (result.sourceAssessment) result.sourceAssessment.scope = 'unique_retrieval_snapshots';
  return result;
}

export function summarizeScheduler(snapshot) {
  if (!snapshot) return null;
  const actions = snapshot.actions || [];
  const receipts = snapshot.receipts || [];
  return { schemaVersion: 1, actionCount: actions.length, dispatchedAttempts: snapshot.round || 0,
    actionsByType: countBy(actions, (action) => action.type), actionsByStatus: countBy(actions, (action) => action.status),
    receiptCount: receipts.length, outcomes: countBy(receipts, (receipt) => receipt.outcome?.execution),
    retryableFailures: receipts.filter((receipt) => receipt.outcome?.execution === 'failed' && receipt.outcome?.retryable).length,
    unknownOutcomes: receipts.filter((receipt) => receipt.outcome?.execution === 'outcome_unknown').length,
    appliedReceiptCount: (snapshot.appliedReceiptIds || []).length,
    sealedPlannerScopes: (snapshot.plannerFailures || []).filter(([, count]) => count >= (snapshot.maxFailures || 3)).length,
    noChangeCycles: snapshot.noChangeCycles || 0, terminal: snapshot.terminal || null };
}
