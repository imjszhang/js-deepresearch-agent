import './types.mjs';

export { ResearchRunner } from './research/research-runner.mjs';
export {
  registerStrategy,
  runStrategy,
  strategyMetadata,
  strategyRegistry,
  getStrategyRegistry,
  resetStrategyRegistry,
} from './research/strategies.mjs';
export {
  createLlmProvider,
  providerMetadata,
  registerLlmProvider,
  resetLlmProviders,
} from './llm/provider-factory.mjs';
export {
  createSearchEngine,
  registerSearchEngine,
  searchEngineMetadata,
  resetSearchEngines,
} from './search/search-factory.mjs';
export { defaultSettings, mergeSettings } from './config/defaults.mjs';
export {
  LIVE_STRATEGY_IDS,
  deprecatedStrategyError,
  isDeprecatedStrategyId,
  isLiveStrategyId,
  mapHistoricalStrategy,
  matchesStrategyFilter,
  sessionMatchesStrategyFilter,
  migrateResearchSettings,
  researchSettingsNeedMigration,
} from './research/strategy-aliases.mjs';
export { getSourceEvidence, getSourceEvidenceClass, sourceHasFetchedBody, resolveFocusedSettings } from './research/focused-settings.mjs';
export { resolveReadSettings } from './research/read-settings.mjs';
export {
  TransportMemory,
  TRANSPORT_MEMORY_SCHEMA_VERSION,
  resolveTransportMemorySettings,
} from './research/transport-memory.mjs';
export {
  resolveExploratorySettings,
  DEFAULT_EXPLORATORY_MIN_LLM_TOKENS,
  DEFAULT_EXPLORATORY_MAX_LLM_TOKENS,
} from './research/exploratory-settings.mjs';
export {
  buildBrowserRequestHeaders,
  cancelResponseBody,
  createEvidenceHttpFetch,
  createHttpFetch,
  DEFAULT_ALLOWED_CONTENT_TYPES,
  DEFAULT_BROWSER_USER_AGENT,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MAX_RESPONSE_BYTES,
  resetHttpFetchCache,
} from './http/create-http-fetch.mjs';
export {
  createWorkSessionDir,
  formatSessionTimestamp,
  resolveWorkDir,
  saveResearchArtifacts,
  saveResearchToWorkDir,
} from './research/work-output.mjs';
export {
  FileRunRecorder,
  NOOP_RUN_RECORDER,
  RUN_RECORD_SCHEMA_VERSION,
  loadLatestCheckpoint,
  readEventJournal,
  recorderOrNoop,
  sanitizeRecordedValue,
} from './research/run-recorder.mjs';
export {
  loadRecordedCallExchange,
  loadRecordedLlmRequest,
  replayRecordedLlmCall,
} from './research/replay-recorded-call.mjs';
export {
  normalizeSearchConfig,
  sanitizeSearchOptions,
  resolveSearchRequestOptions,
  publicSearchOptionsSnapshot,
} from './search/normalize-search-config.mjs';
export { attachSearchMeta, getSearchMeta, collectRespondedEngines } from './search/search-result.mjs';
export {
  SearchProviderError,
  searchErrorFromProviderPayload,
  serializeSearchError,
  isTransientSearchError,
  inferOutcomeFromError,
  classifySearchProgress,
  classifyInvalidReason,
} from './search/search-provider-error.mjs';
export { buildPlannerFeedback, plannerFeedbackFromState } from './research/planner-feedback.mjs';
export {
  assessSourceBody,
  normalizeSourceAssessment,
  failClosedAssessment,
} from './research/source-assessment.mjs';
export { collectObservabilityMetrics } from './research/observability.mjs';
export {
  resolveSearchConcurrency,
  resolveSearchCapabilities,
  filterSearchOptions,
  DEFAULT_SEARCH_CAPABILITIES,
  SEARCH_OPTION_KEYS,
} from './search/search-capabilities.mjs';
export { BudgetManager, BudgetExceededError } from './research/budget-manager.mjs';
export { QueryMemory, normalizeQuery, querySimilarity } from './research/query-memory.mjs';
export {
  RESEARCH_BRIEF_SCHEMA_VERSION,
  RESEARCH_QUERY_SHAPES,
  sanitizeResearchBrief,
  sanitizeAnswerSlots,
  researchBriefFromInput,
  mergeResearchBrief,
  slotsFromPlannerGaps,
  sanitizeAsOf,
} from './research/research-brief.mjs';
export {
  PROFILE_EVIDENCE_CRITERIA,
  PROFILE_QUERY_SHAPES,
  buildProfileUserMessage,
  profileSystemPrompt,
} from './research/research-profile-prompt.mjs';
export {
  applyAsOfGate,
  resolveCompletionStatus,
  slotEvidenceLimitations,
  sourceUsableForAsOf,
} from './research/as-of.mjs';
export { buildResearchLimitations } from './research/limitations.mjs';
export { promoteSuccessfulSources, shouldPromoteSourceToSlot } from './research/slot-promotion.mjs';
export {
  GAP_SCHEMA_VERSION,
  GAP_STATUSES,
  EVIDENCE_STATUSES,
  normalizeGapRecord,
  normalizeRepairState,
  evaluateGapEvidence,
  evaluateGapProvenance,
  synthesizeGapStatus,
  inferEvidenceStatus,
  evidenceStatusOf,
  isRepairTerminal,
  deriveGapOutcome,
  isMaterialGap,
  isRequiredSlot,
  needsSemanticClose,
  rollupRootGap,
} from './research/gap-state.mjs';
export { normalizeSourceUrl, selectDiverseSources, SourceCandidatePool, isPrimarySource, sourceDiversityKey, isFileSourceUrl } from './research/source-candidates.mjs';
export {
  buildEvidenceArtifacts,
  buildPassageArtifacts,
  buildPassageArtifactsAsync,
  alignReportClaims,
  alignPlanClaims,
  extractClaims,
  stableSourceId,
  alignClaimToCitedPassages,
  listSnippetOnlyCitationKeys,
  selectDisplayedEvidence,
  boundEvidenceText,
  DEFAULT_MAX_PASSAGE_CHARS,
} from './research/evidence-chain.mjs';
export {
  parseCitations,
  parseInternalReferenceTokens,
  stripInternalReferenceTokens,
  buildCitationMap,
  resolveCitations,
  resolveCitedSourceIds,
} from './research/citations.mjs';
export {
  ReportGenerationError,
  validateReportOutput,
  looksTruncated,
  isPlaceholderSummary,
  emptyBulletLines,
  extractLabeledNarrativeText,
  classifyReportFailurePhase,
  sanitizeReportFailedChecks,
  looksLikeStructuredNarrative,
  REPORT_FAILURE_PHASES,
} from './research/report-builder.mjs';
export {
  isWafOrErrorBody,
  isSuccessfulBody,
  isTransportReadSkip,
  isRawBinaryDocumentText,
  classifyFetchedBody,
  sanitizeUnusableSourceBody,
  MIN_FETCHED_BODY_CHARS,
} from './research/body-quality.mjs';
export {
  detectDocumentFormat,
  convertDocumentToMarkdown,
} from './research/document-converter.mjs';
export {
  inferResearchProfile,
  sanitizeEvidenceProfile,
  planResearchProfile,
  hasUsableResearchContract,
} from './research/adaptive/research-profile.mjs';
export {
  EVIDENCE_CRITERIA,
  FIRST_PARTY_RETRIEVAL_TERMS,
  evaluateEvidenceCriteria,
  gapAsksFirstParty,
  normalizeEvidenceCriteria,
} from './research/evidence-criteria.mjs';
export {
  judgeOpenSlotSupport,
  applySlotSupportJudgments,
  failClosedSupport,
  selectSlotPassages,
  slotSupportFingerprint,
} from './research/gap-slot-support.mjs';
export { evaluateReadinessGate, repairGapsFromGate } from './research/adaptive/readiness-gate.mjs';
export {
  partitionFindingsForReport,
  applySlotStatusToClaims,
  evidenceGradeForGap,
  owningRequiredGap,
  isJudgmentContext,
  hasOpenJudgmentSlot,
  hasOpenRequiredSlot,
  claimHasIndependentFirstPartyEvidence,
  findingHasFirstPartyBody,
} from './research/report-evidence.mjs';
export {
  classifySourceTier,
  evaluateSourceRelevance,
  resolveEntityAliases,
  matchEntityAlias,
  documentMatchesQuerySubject,
  isExternalRerankProvider,
  evidenceIndependenceKey,
  hostnameOf,
  canonicalSourceHref,
  independentEvidenceKeysFromSources,
  inferEvidenceScope,
  registrableDomainFromUrl,
  selectReadsByPolicy,
} from './research/adaptive/source-policy.mjs';
export {
  planSearchQueries,
  attachPlannedQueries,
  validatePlannedQuery,
  QUERY_ORIGINS,
  SEARCH_QUERY_MODES,
  SEARCH_QUERY_PLANNER_PURPOSE,
} from './research/search-query-planner.mjs';
export { normalizeExploratoryStopReason, EXPLORATORY_STOP_REASONS } from './research/adaptive/stop-reasons.mjs';
export {
  assembleReport,
  reviseUnsupportedKeyClaims,
  reviseNarrativeDocument,
  shouldMoveWeakKeyClaim,
  shouldMoveWeakPremiseFact,
  stripEmptyNarrativeSections,
  keepNarrativeSections,
  containsSourceDump,
  normalizeCaveatKey,
} from './research/report-assembler.mjs';
export { resolveReportSettings } from './research/report-settings.mjs';
export {
  extractJsonObject,
  validateNarrativeObject,
  renderNarrativeMarkdown,
  parseNarrativeResponse,
  parseMarkdownNarrative,
  normalizeNarrativeDocument,
  sanitizeNarrativeText,
  sanitizeNarrativeResponse,
  containsSourceDump as narrativeContainsSourceDump,
} from './research/report-narrative.mjs';
export {
  REPORT_CONTRACT_VERSION,
  buildReportContract,
  formatContractPromptBlock,
} from './research/report-contract.mjs';
export {
  REPORT_PLAN_VERSION,
  buildReportPlan,
  validateReportPlan,
  mergeNarrativeIntoPlan,
  ensureKeyFindingPlacements,
  flattenPlanClaims,
  documentFromPlan,
} from './research/report-plan.mjs';
export {
  shouldJudgeClaim,
  applyEntailmentVerdict,
  applyClaimEntailment,
  passageContainsQuote,
} from './research/claim-entailment.mjs';
export { createResearchProviders, deterministicResearchProviders } from './research/research-providers.mjs';
export { DisabledRerankProvider, RulesRerankProvider } from './research/providers/rules-rerank-provider.mjs';
export { JinaRerankProvider } from './research/providers/jina-rerank-provider.mjs';
export { HttpRerankProvider } from './research/providers/http-rerank-provider.mjs';
export { OpenAiEmbeddingProvider, cosineSimilarity } from './research/providers/openai-embedding-provider.mjs';
export { SemanticProviderError, isAbortError } from './research/providers/semantic-provider-errors.mjs';
export {
  QUALITY_METRICS_VERSION,
  CLAIM_EXTRACTION_VERSION,
  CLAIM_EVALUATION_VERSION,
  CLAIM_VERDICTS,
  FACT_CLAIM_KINDS,
  classifyClaimSection,
  resolveClaimKindFromHeadingStack,
  extractQualityClaims,
  extractClaimsFromDocument,
  mergeCanonicalClaims,
  placementFromSection,
  normalizedClaimKey,
  splitAtomicClaimTexts,
  aggregateEvidenceVerdict,
  buildClaimEvaluation,
  normalizeClaim,
  calculateQualityMetrics,
  qualityGateFromClaims,
  selectCountableClaims,
} from './research/claim-quality.mjs';
export { resetEngineRegistries } from './registry-reset.mjs';
export {
  registerContentFetchHandler,
  resetContentFetchHandlers,
  resolveUrlContent,
  resolveContentFetchImpl,
  getContentFetchHandlers,
} from './research/content-resolver.mjs';
export {
  buildCacheKey,
  contentSha256,
  lookupContentCache,
  normalizeCacheUrl,
  resolveContentCacheSettings,
  storeContentCache,
} from './research/content-cache.mjs';
export {
  collectManualImportHints,
  indexManualImports,
  lookupManualImport,
  parseSourceUrlFrontMatter,
  readManualImportSidecar,
} from './research/manual-import.mjs';
