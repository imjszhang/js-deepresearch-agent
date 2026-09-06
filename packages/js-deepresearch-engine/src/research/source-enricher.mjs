import crypto from 'node:crypto';
import { resolveUrlContent } from './content-resolver.mjs';
import { focusedSourceSelection } from './focused-settings.mjs';
import { selectRelevantPassages } from './passage-selector.mjs';
import { withSourceProvenance } from './source-provenance.mjs';
import { evaluateSourceRelevance } from './adaptive/source-policy.mjs';
import {
  ASSESSMENT_STATUS,
  assessSourceBody,
  assessmentBlocksSuccessfulBody,
} from './source-assessment.mjs';

function relatedLinksFromFetch(fetched, settings) {
  const selection = focusedSourceSelection(settings);
  if (!selection?.expandPageLinks) return undefined;
  return (fetched.links || []).slice(0, selection.maxExpandedLinksPerPage || 5);
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

const SKIPPED_ASSESSMENT = Object.freeze({
  assessment: null,
  status: ASSESSMENT_STATUS.skipped,
});

/**
 * Assessment outcome fields, kept separate from the transport fact
 * (`fetchStatus`) and from the deterministic body verdict (`bodyQuality`).
 */
function assessmentFields(outcome) {
  const status = outcome?.status || ASSESSMENT_STATUS.skipped;
  if (status === ASSESSMENT_STATUS.skipped) {
    return { assessment: outcome?.assessment || null, assessmentStatus: status };
  }
  return {
    assessment: outcome.assessment,
    assessmentStatus: status,
    assessmentAttempts: Number(outcome.attempts) || 1,
    assessmentRetried: outcome.retried === true,
    assessmentReason: status === ASSESSMENT_STATUS.unavailable
      ? (outcome.assessment?.reason || 'assessment_unavailable')
      : null,
  };
}

/**
 * A real LLM verdict of `unreadable` is a content judgment, so it lands in
 * `bodyQuality`. The transport fact stays untouched: the bytes did arrive.
 */
function blockedAssessmentResult(fetchedSource, outcome) {
  return {
    ...fetchedSource,
    summary: '',
    ...assessmentFields(outcome),
    fetchStatus: 'ok',
    bodyQuality: 'waf',
    skipReason: outcome?.assessment?.reason || 'assessment_unreadable',
  };
}

async function maybeAssessSource(source, fetched, {
  llm,
  signal,
  query,
  question,
  entities,
  entityAliases,
  relevanceGap,
  observedHosts,
}) {
  if (!llm?.complete) return SKIPPED_ASSESSMENT;
  return assessSourceBody({
    llm,
    signal,
    query,
    question,
    title: source.title || fetched.title,
    url: String(source.url || '').trim(),
    content: fetched.content,
    entities: [...new Set([...(entities || []), ...(entityAliases || [])])],
    preferredHosts: relevanceGap?.preferredHosts || [],
    observedHosts: observedHosts || [],
  });
}

async function enrichOneSource(source, {
  query,
  question,
  llm,
  signal,
  fetchMode,
  maxContentChars,
  maxFetchChars,
  settings,
  budget,
  embedding,
  relevance,
  relevanceGap,
  entities,
  entityAliases,
  observedHosts,
  recorder,
}) {
  const url = String(source.url || '').trim();
  if (!url) {
    return {
      ...source,
      fetchStatus: 'skipped',
      fetchError: 'Missing URL',
    };
  }

  budget?.claim('sourceReads');
  const callId = `fetch-${crypto.randomUUID()}`;
  recorder?.callStarted?.({
    callId,
    kind: 'content-fetch',
    request: {
      url,
      sourceId: source.id || null,
      maxChars: maxFetchChars || maxContentChars,
      fetchBackend: settings?.research?.read?.fetchBackend
        || settings?.research?.focused?.fetchBackend
        || 'auto',
      viaProxy: Boolean(String(settings?.http?.proxy || '').trim()),
    },
  });
  let fetched;
  const fetchStartedAt = Date.now();
  try {
    fetched = await resolveUrlContent(url, {
      source,
      settings,
      signal,
      maxChars: maxFetchChars || maxContentChars,
    });
    recorder?.callFinished?.({
      callId,
      kind: 'content-fetch',
      status: fetched.status === 'ok' ? 'completed' : 'failed',
      response: fetched,
      durationMs: Date.now() - fetchStartedAt,
    });
  } catch (error) {
    recorder?.callFinished?.({
      callId,
      kind: 'content-fetch',
      status: error?.name === 'AbortError' ? 'cancelled' : 'failed',
      error,
      durationMs: Date.now() - fetchStartedAt,
    });
    throw error;
  }
  if (fetched.status !== 'ok') {
    return {
      ...withSourceProvenance(source, fetched),
      fetchStatus: 'failed',
      fetchError: fetched.error || 'Fetch failed',
      fetchErrorType: fetched.errorType || null,
      httpStatus: fetched.httpStatus ?? null,
      fetchAttempts: fetched.fetchAttempts ?? 1,
      accessStatus: fetched.accessStatus || 'failed',
      accessNotes: fetched.accessNotes || fetched.error || 'Fetch failed',
    };
  }

  const fetchedSource = {
    ...withSourceProvenance(source, fetched),
    title: source.title || fetched.title,
    content: fetched.content,
    contentOrigin: 'fetched',
    fetchStatus: 'ok',
  };
  if (relevance && relevance.bodyValidation !== false) {
    const relevanceDecision = evaluateSourceRelevance(fetchedSource, {
      ...relevance,
      gap: relevanceGap || { question },
      query: question || query,
      entities,
      entityAliases,
      enforceEntity: relevance.entityGuard !== false,
      rerankProvider: 'disabled',
      allowRequiredHostProbe: false,
    });
    if (!relevanceDecision.accepted) {
      return {
        ...fetchedSource,
        bodyQuality: 'irrelevant',
        bodyQualityReason: relevanceDecision.reasonCode,
        relevanceDecision,
        skipReason: relevanceDecision.reasonCode,
      };
    }
    fetchedSource.relevanceDecision = relevanceDecision;
  }

  const assessmentEnabled = settings?.research?.read?.sourceAssessment?.enabled === true;
  const analysisLimit = Math.max(600, Number(maxContentChars) || 8000);
  const needsBoundedAnalysis = fetchMode !== 'full' || assessmentEnabled;
  const analysisContent = needsBoundedAnalysis && fetched.content.length > analysisLimit
    ? await selectRelevantPassages({
      query,
      question,
      content: fetched.content,
      snippet: source.snippet,
      embedding,
      signal,
      topK: Math.max(3, Math.ceil(analysisLimit / 1200)),
      chunkChars: 1200,
      windowChunks: 1,
      shortContentChars: analysisLimit,
    })
    : fetched.content;
  const assessmentFetched = {
    ...fetched,
    content: analysisContent,
  };

  const extraAssessment = async () => {
    if (!assessmentEnabled) return SKIPPED_ASSESSMENT;
    return maybeAssessSource(source, assessmentFetched, {
      llm,
      signal,
      query,
      question,
      entities,
      entityAliases,
      relevanceGap,
      observedHosts,
    });
  };

  if (fetchMode === 'full') {
    const outcome = await extraAssessment();
    if (assessmentBlocksSuccessfulBody(outcome.assessment)) {
      return blockedAssessmentResult(fetchedSource, outcome);
    }
    return {
      ...fetchedSource,
      ...assessmentFields(outcome),
      fetchStatus: 'ok',
      relatedLinks: relatedLinksFromFetch(fetched, settings),
    };
  }

  if (fetchMode === 'extract') {
    const summary = analysisContent;
    const outcome = await extraAssessment();
    if (assessmentBlocksSuccessfulBody(outcome.assessment)) {
      return blockedAssessmentResult(fetchedSource, outcome);
    }
    return {
      ...fetchedSource,
      summary: String(summary || '').trim() || source.snippet,
      extractionMethod: embedding ? 'embedding' : 'overlap',
      ...assessmentFields(outcome),
      fetchStatus: 'ok',
      relatedLinks: relatedLinksFromFetch(fetched, settings),
    };
  }

  const outcome = await maybeAssessSource(source, assessmentFetched, {
    llm,
    signal,
    query,
    question,
    entities,
    entityAliases,
    relevanceGap,
    observedHosts,
  });
  if (assessmentBlocksSuccessfulBody(outcome.assessment)) {
    return blockedAssessmentResult(fetchedSource, outcome);
  }

  // No verdict available (assessment skipped or unparseable): keep the fetched
  // body and fall back to the snippet for display. The deterministic
  // body-quality rules still decide whether this counts as evidence.
  return {
    ...fetchedSource,
    summary: outcome.assessment?.summary || source.snippet,
    ...assessmentFields(outcome),
    fetchStatus: 'ok',
    relatedLinks: relatedLinksFromFetch(fetched, settings),
  };
}

export async function enrichFindingSources(finding, options = {}) {
  const {
    query,
    fetchMode,
    maxUrlsPerIteration,
    maxUrlsTotal,
    maxContentChars,
    maxFetchChars,
    enrichConcurrency,
    llm,
    signal,
    settings,
    budget,
    embedding,
    relevance,
    relevanceGap,
    entities,
    entityAliases,
    observedHosts,
    recorder,
    seenUrls = new Set(),
    enrichedCount = { value: 0 },
  } = options;

  if (fetchMode === 'disabled' || !Array.isArray(finding?.sources) || finding.sources.length === 0) {
    return finding;
  }

  const candidates = [];
  for (const source of finding.sources) {
    if (budget && !budget.canClaim('sourceReads')) break;
    const url = String(source.url || '').trim();
    if (!url || seenUrls.has(url)) continue;
    if (enrichedCount.value >= maxUrlsTotal) break;
    if (candidates.length >= maxUrlsPerIteration) break;
    seenUrls.add(url);
    candidates.push(source);
  }

  if (candidates.length === 0) {
    if (budget && !budget.canClaim('sourceReads')) budget.markExhausted('sourceReads');
    return finding;
  }

  const enrichedByUrl = new Map();
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < candidates.length) {
      if (signal?.aborted) {
        const error = new Error('Research aborted');
        error.name = 'AbortError';
        throw error;
      }

      if (budget && !budget.canClaim('sourceReads')) {
        budget.markExhausted('sourceReads');
        break;
      }

      const index = nextIndex;
      nextIndex += 1;
      const source = candidates[index];

      try {
        const enriched = await enrichOneSource(source, {
          query,
          question: finding.question,
          llm,
          signal,
          fetchMode,
          maxContentChars,
          maxFetchChars,
          settings,
          budget,
          embedding,
          relevance,
          relevanceGap,
          entities,
          entityAliases,
          observedHosts,
          recorder,
        });
        enrichedByUrl.set(source.url, enriched);
        if (enriched.fetchStatus === 'ok') {
          enrichedCount.value += 1;
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        enrichedByUrl.set(source.url, {
          ...source,
          fetchStatus: 'failed',
          fetchError: error.message,
        });
      }
    }
  }

  const workers = Math.min(enrichConcurrency, candidates.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  return {
    ...finding,
    sources: finding.sources.map((source) => enrichedByUrl.get(source.url) || source),
  };
}

export async function enrichFindings(findings = [], options = {}) {
  const seenUrls = new Set();
  const enrichedCount = { value: 0 };
  const enrichedFindings = [];

  for (const finding of findings) {
    enrichedFindings.push(await enrichFindingSources(finding, {
      ...options,
      seenUrls,
      enrichedCount,
    }));
  }

  return enrichedFindings;
}
