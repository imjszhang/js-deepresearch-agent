function readExploratoryRaw(settings = {}) {
  return settings?.research?.exploratory || settings?.research?.adaptive || {};
}

export function resolveExploratorySettings(settings = {}) {
  const raw = readExploratoryRaw(settings);
  const targetRaw = raw.targetLlmTokens;
  return {
    maxSteps: Number(raw.maxSteps) || 16,
    targetLlmTokens: targetRaw === undefined || targetRaw === null ? 20000 : (Number(targetRaw) || 0),
    maxGapDepth: Number(raw.maxGapDepth) || 2,
    maxOpenGaps: Number(raw.maxOpenGaps) || 8,
    maxQueriesPerStep: Number(raw.maxQueriesPerStep) || 3,
    maxReadsPerStep: Number(raw.maxReadsPerStep) || 4,
    plannerParallelism: Number(raw.plannerParallelism) || 2,
    enableCoding: raw.enableCoding === true,
    gateMode: raw.gateMode || 'rules-then-llm',
    maxEvaluationRetries: raw.maxEvaluationRetries === undefined ? 1 : Number(raw.maxEvaluationRetries),
    answerGate: raw.answerGate !== false,
    autoReadTopK: raw.autoReadTopK,
  };
}
