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
 * @property {string} [jsEyesCli]
 * @property {string} [jsEyesSkill]
 * @property {string[]} [jsEyesSkills]
 * @property {string} [jsEyesCommand]
 * @property {string} [jsEyesServerUrl]
 * @property {number} [jsEyesMaxPages]
 * @property {number} [jsEyesTimeoutMs]
 * @property {Record<string, unknown>} [jsEyesArgs]
 * @property {Record<string, unknown>} [options]
 * @property {JsEyesProviderConfig} [provider]
 */

/**
 * @typedef {Object} JsEyesProviderConfig
 * @property {string} [cli]
 * @property {'auto'|'unified'|'skill-run'} [driver]
 * @property {string} [serverUrl]
 * @property {number} [timeoutMs]
 * @property {number} [maxPages]
 * @property {string[]} [skills]
 * @property {Record<string, unknown>} [args]
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

export {};
