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
 * @typedef {Object} SearchSettings
 * @property {string} engine
 * @property {string} [baseUrl]
 * @property {string} [apiKey]
 * @property {number} [maxResults]
 * @property {string} [language]
 * @property {boolean} [safeSearch]
 * @property {Record<string, unknown>} [options]
 * @property {Record<string, unknown>} [provider]
 */

/**
 * @typedef {Object} ResearchSettings
 * @property {string} strategy
 * @property {number} [iterations]
 * @property {number} [questionsPerIteration]
 * @property {number} [concurrency]
 * @property {string} [workDir]
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
 * @property {'research_started'|'synthesizing_report'|'research_complete'|'generating_questions'|'searching'|'search_item_complete'|'search_progress'} stage
 * @property {'rapid'|'source-based'|'parallel'} [strategy]
 * @property {number} [iteration]
 * @property {number} [iterations]
 * @property {number} [completed]
 * @property {number} [total]
 * @property {string} [question]
 * @property {'info'|'error'} [level]
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
 * @property {Settings} [settings]
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
