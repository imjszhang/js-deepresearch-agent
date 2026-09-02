import { resolveUrlContent } from './content-resolver.mjs';
import { focusedSourceSelection } from './focused-settings.mjs';
import { selectRelevantPassages } from './passage-selector.mjs';
import { withSourceProvenance } from './source-provenance.mjs';
import { evaluateSourceRelevance } from './adaptive/source-policy.mjs';
import { assessSourceBody, assessmentBlocksSuccessfulBody } from './source-assessment.mjs';

function relatedLinksFromFetch(fetched, settings) {
  const selection = focusedSourceSelection(settings);
  if (!selection?.expandPageLinks) return undefined;
  return (fetched.links || []).slice(0, selection.maxExpandedLinksPerPage || 5);
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function blockedAssessmentResult(fetchedSource, assessment) {
  return {
    ...fetchedSource,
    summary: '',
    assessment,
    fetchStatus: 'failed',
    bodyQuality: 'waf',
    skipReason: assessment?.reason || 'assessment_unreadable',
  };
}

async function maybeAssessSource(source, fetched, {
  llm,
  signal,
  query,
  question,
  entities,
  relevanceGap,
  observedHosts,
}) {
  if (!llm?.complete) return null;
  const { assessment } = await assessSourceBody({
    llm,
    signal,
    query,
    question,
    title: source.title || fetched.title,
    url: String(source.url || '').trim(),
    content: fetched.content,
    entities,
    preferredHosts: relevanceGap?.preferredHosts || [],
    observedHosts: observedHosts || [],
  });
  return assessment;
}

async function enrichOneSource(source, {
  query,
  question,
  llm,
  signal,
  fetchMode,
  maxContentChars,
  settings,
  budget,
  embedding,
  relevance,
  relevanceGap,
  entities,
  observedHosts,
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
  const fetched = await resolveUrlContent(url, {
    source,
    settings,
    signal,
    maxChars: maxContentChars,
  });
  if (fetched.status !== 'ok') {
    return {
      ...withSourceProvenance(source, fetched),
      fetchStatus: 'failed',
      fetchError: fetched.error || 'Fetch failed',
      accessStatus: fetched.accessStatus || 'failed',
      accessNotes: fetched.accessNotes || fetched.error || 'Fetch failed',
    };
  }

  const fetchedSource = {
    ...withSourceProvenance(source, fetched),
    title: source.title || fetched.title,
    content: fetched.content,
    contentOrigin: 'fetched',
  };
  if (relevance && relevance.bodyValidation !== false) {
    const relevanceDecision = evaluateSourceRelevance(fetchedSource, {
      ...relevance,
      gap: relevanceGap || { question },
      query: question || query,
      entities,
      enforceEntity: relevance.entityGuard !== false,
      rerankProvider: 'disabled',
      allowRequiredHostProbe: false,
    });
    if (!relevanceDecision.accepted) {
      return {
        ...fetchedSource,
        fetchStatus: 'irrelevant',
        bodyQuality: 'irrelevant',
        relevanceDecision,
        skipReason: relevanceDecision.reasonCode,
      };
    }
  }

  const assessmentEnabled = settings?.research?.read?.sourceAssessment?.enabled === true;
  const extraAssessment = async () => {
    if (!assessmentEnabled) return null;
    return maybeAssessSource(source, fetched, {
      llm,
      signal,
      query,
      question,
      entities,
      relevanceGap,
      observedHosts,
    });
  };

  if (fetchMode === 'full') {
    const assessment = await extraAssessment();
    if (assessmentBlocksSuccessfulBody(assessment)) {
      return blockedAssessmentResult(fetchedSource, assessment);
    }
    return {
      ...fetchedSource,
      assessment,
      fetchStatus: 'ok',
      relatedLinks: relatedLinksFromFetch(fetched, settings),
    };
  }

  if (fetchMode === 'extract') {
    const summary = await selectRelevantPassages({
      query,
      question,
      content: fetched.content,
      snippet: source.snippet,
      embedding,
      signal,
    });
    const assessment = await extraAssessment();
    if (assessmentBlocksSuccessfulBody(assessment)) {
      return blockedAssessmentResult(fetchedSource, assessment);
    }
    return {
      ...fetchedSource,
      summary: String(summary || '').trim() || source.snippet,
      extractionMethod: embedding ? 'embedding' : 'overlap',
      assessment,
      fetchStatus: 'ok',
      relatedLinks: relatedLinksFromFetch(fetched, settings),
    };
  }

  const assessment = await maybeAssessSource(source, fetched, {
    llm,
    signal,
    query,
    question,
    entities,
    relevanceGap,
    observedHosts,
  });
  if (assessment && assessmentBlocksSuccessfulBody(assessment)) {
    return blockedAssessmentResult(fetchedSource, assessment);
  }
  if (!assessment) {
    return {
      ...fetchedSource,
      summary: source.snippet,
      fetchStatus: 'ok',
      relatedLinks: relatedLinksFromFetch(fetched, settings),
    };
  }

  return {
    ...fetchedSource,
    summary: assessment.summary || source.snippet,
    assessment,
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
    enrichConcurrency,
    llm,
    signal,
    settings,
    budget,
    embedding,
    relevance,
    relevanceGap,
    entities,
    observedHosts,
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
          settings,
          budget,
          embedding,
          relevance,
          relevanceGap,
          entities,
          observedHosts,
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
