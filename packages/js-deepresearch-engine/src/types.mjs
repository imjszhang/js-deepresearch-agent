/**
 * @typedef {Object} LlmSettings
 * @property {string} provider
 * @property {string} model
 * @property {string} [apiKey]
 * @property {string} [baseUrl]
 * @property {number} [temperature]
 * @property {number} [maxTokens]
 */

/**
 * @typedef {Object} SearchBackendSettings
 * @property {string} id
 * @property {string} engine
 * @property {boolean} [enabled]
 * @property {Record<string, unknown>} [settings]
 */

/**
 * @typedef {Object} SearchFanoutSettings
 * @property {'partial'} [failurePolicy]
 * @property {'round-robin'} [merge]
 * @property {number} [maxParallelBackends]
 */

/**
 * @typedef {Object} SearchSettings
 * @property {string} engine
 * @property {'single'|'fanout'} [mode]
 * @property {string} [baseUrl]
 * @property {string} [apiKey]
 * @property {number} [maxResults]
 * @property {string} [language]
 * @property {boolean} [safeSearch]
 * @property {Record<string, unknown>} [options]
 * @property {Record<string, unknown>} [provider]
 * @property {SearchBackendSettings[]} [backends]
 * @property {SearchFanoutSettings} [fanout]
 */

/**
 * @typedef {Object} FocusedSettings
 * @property {'disabled'|'full'|'summary'|'extract'} [fetchMode]
 * @property {'auto'|'http'|'js-eyes'} [fetchBackend]
 * @property {number} [maxUrlsPerIteration]
 * @property {number} [maxUrlsTotal]
 * @property {number} [maxContentChars]
 * @property {number} [enrichConcurrency]
 * @property {boolean} [enableRelevanceFilter]
 * @property {number} [maxSourcesForReport]
 * @property {number} [questionContextLimit]
 * @property {number} [contextCharsPerSource]
 * @property {Record<string, unknown>} [iterationControl]
 */

/**
 * @typedef {Object} ResearchSettings
 * @property {string} strategy
 * @property {number} [iterations]
 * @property {number} [questionsPerIteration]
 * @property {number} [concurrency]
 * @property {string} [workDir]
 * @property {FocusedSettings} [focused]
 * @property {Record<string, number>} [budget]
 * @property {Record<string, unknown>} [exploratory]
 */

/**
 * @typedef {Object} Settings
 * @property {LlmSettings} llm
 * @property {SearchSettings} search
 * @property {ResearchSettings} research
 */

/**
 * @typedef {Object} Source
 * @property {string} title
 * @property {string} url
 * @property {string} snippet
 * @property {string} [engine]
 * @property {string} [content]
 * @property {string} [summary]
 * @property {'skipped'|'ok'|'failed'} [fetchStatus]
 * @property {string} [fetchError]
 * @property {number} [relevanceScore]
 * @property {boolean} [relevanceKeep]
 * @property {string} [relevanceReason]
 */

/**
 * @typedef {Object} Finding
 * @property {string} question
 * @property {Source[]} sources
 * @property {number} [iteration]
 * @property {Error} [error]
 */

/**
 * @typedef {Object} ProgressEvent
 * @property {string} message
 * @property {number|null} [progress]
 * @property {'info'|'error'} [level]
 */

/**
 * @typedef {Object} StrategyProgressEvent
 * @property {string} stage
 * @property {number} [iteration]
 * @property {number} [iterations]
 * @property {number} [completed]
 * @property {number} [total]
 * @property {string} [question]
 * @property {StrategyProgressProfile} [progressProfile]
 * @property {'info'|'error'} [level]
 */

/**
 * @typedef {Object} StrategyProgressProfile
 * @property {(event: StrategyProgressEvent) => string} [generateQuestionsMessage]
 * @property {(event: StrategyProgressEvent) => string} [searchStartMessage]
 * @property {(event: StrategyProgressEvent) => string} [searchItemCompleteMessage]
 * @property {(event: StrategyProgressEvent) => number} [searchItemProgress]
 * @property {(event: StrategyProgressEvent) => string} [searchProgressMessage]
 * @property {(event: StrategyProgressEvent) => string} [enrichingSourcesMessage]
 * @property {(event: StrategyProgressEvent) => string} [filteringSourcesMessage]
 */

/**
 * @typedef {Object} LlmClient
 * @property {(args: { messages: Array<{ role: string, content: string }>, signal?: AbortSignal, temperature?: number, maxTokens?: number }) => Promise<string>} complete
 */

/**
 * @typedef {Object} SearchCapabilities
 * @property {number|null} [maxQuestionConcurrency]
 */

/**
 * @typedef {Object} SearchEngine
 * @property {(query: string, options?: { signal?: AbortSignal }) => Promise<Source[]>} search
 * @property {SearchCapabilities} [capabilities]
 * @property {string} [id]
 * @property {'single'|'composite'} [kind]
 */

/**
 * @typedef {Object} StrategyContext
 * @property {string} query
 * @property {number} iterations
 * @property {number} questionCount
 * @property {number|undefined} concurrency
 * @property {LlmClient} llm
 * @property {SearchEngine} search
 * @property {AbortSignal|undefined} [signal]
 * @property {(input: string|StrategyProgressEvent, progress?: number, level?: 'info'|'error') => void} emit
 * @property {StrategyProgressProfile} [progressProfile]
 * @property {Settings} [settings]
 * @property {import('./research/budget-manager.mjs').BudgetManager} [budget]
 * @property {import('./research/query-memory.mjs').QueryMemory} [queryMemory]
 * @property {Array<Record<string, unknown>>} [trace]
 */

/**
 * @typedef {Object} StrategyRunInput
 * @property {string} query
 * @property {Settings} settings
 * @property {LlmClient} llm
 * @property {SearchEngine} search
 * @property {AbortSignal|undefined} [signal]
 * @property {(input: string|StrategyProgressEvent, progress?: number, level?: 'info'|'error') => void} emit
 */

export {};
