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
export { resolveExploratorySettings } from './research/exploratory-settings.mjs';
export { createHttpFetch, resetHttpFetchCache } from './http/create-http-fetch.mjs';
export {
  createWorkSessionDir,
  formatSessionTimestamp,
  resolveWorkDir,
  saveResearchArtifacts,
  saveResearchToWorkDir,
} from './research/work-output.mjs';
export { normalizeSearchConfig } from './search/normalize-search-config.mjs';
export { resolveSearchConcurrency, resolveCompositeQuestionConcurrency } from './search/search-capabilities.mjs';
export {
  DEFAULT_FANOUT_OPTIONS,
  resolveSearchMode,
  parseSearchEngineList,
  buildFanoutBackendsFromEngines,
  resolveEnabledBackends,
  resolveFanoutOptions,
  mergeBackendSettings,
} from './search/fanout-config.mjs';
export { mergeSearchResults } from './search/merge-search-results.mjs';
export { CompositeSearchEngine, FanoutSearchError, createFanoutSearchEngine } from './search/fanout-engine.mjs';
export { BudgetManager, BudgetExceededError, wrapProvidersWithBudget } from './research/budget-manager.mjs';
export { QueryMemory, normalizeQuery, querySimilarity } from './research/query-memory.mjs';
export { normalizeSourceUrl, selectDiverseSources, SourceCandidatePool, isPrimarySource } from './research/source-candidates.mjs';
export {
  buildEvidenceArtifacts,
  extractClaims,
  stableSourceId,
  alignClaimToCitedPassages,
  listSnippetOnlyCitationKeys,
} from './research/evidence-chain.mjs';
export {
  parseCitations,
  buildCitationMap,
  resolveCitations,
  resolveCitedSourceIds,
} from './research/citations.mjs';
export { ReportGenerationError, validateReportOutput, looksTruncated, isPlaceholderSummary } from './research/report-builder.mjs';
export {
  assembleReport,
  reviseUnsupportedKeyClaims,
  keepNarrativeSections,
  containsSourceDump,
} from './research/report-assembler.mjs';
export { resolveReportSettings } from './research/report-settings.mjs';
export {
  extractJsonObject,
  validateNarrativeObject,
  renderNarrativeMarkdown,
  parseNarrativeResponse,
} from './research/report-narrative.mjs';
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
  getContentFetchHandlers,
} from './research/content-resolver.mjs';
