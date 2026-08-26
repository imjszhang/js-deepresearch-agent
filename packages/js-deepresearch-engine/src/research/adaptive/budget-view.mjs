const ACTION_PRIORS = {
  search: 80,
  read: 600,
  reflect: 400,
  answer: 1600,
  decide: 400,
};

export function estimateTokensFromText(text) {
  return Math.ceil(String(text || '').length / 4);
}

export function estimateReportPromptTokens({ query, findings = [] } = {}) {
  const questions = findings.map((finding) => finding.question || '').join('\n');
  const evidence = findings.flatMap((finding) => (finding.sources || []).map((source) => (
    source.summary || source.content || source.snippet || ''
  ))).join('\n');
  return estimateTokensFromText(query)
    + estimateTokensFromText(questions)
    + estimateTokensFromText(evidence)
    + 350;
}

export class ActionCostTracker {
  constructor(priors = ACTION_PRIORS) {
    this.priors = { ...ACTION_PRIORS, ...priors };
    this.samples = {
      search: [],
      read: [],
      reflect: [],
      answer: [],
      decide: [],
    };
  }

  record(action, tokens) {
    const key = this.samples[action] ? action : null;
    const amount = Number(tokens);
    if (!key || !Number.isFinite(amount) || amount < 0) return;
    this.samples[key].push(amount);
    if (this.samples[key].length > 12) this.samples[key].shift();
  }

  estimate(action) {
    const samples = this.samples[action] || [];
    if (!samples.length) return this.priors[action] || 0;
    return Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
  }

  snapshot() {
    return Object.fromEntries(['search', 'read', 'reflect', 'answer'].map((action) => [action, {
      estimatedTokens: this.estimate(action),
      samples: this.samples[action].length,
    }]));
  }
}

export function buildBudgetView({ budget, actionCosts, minLlmTokens, targetLlmTokens } = {}) {
  const used = Number(budget?.usage?.llmTokens) || 0;
  const hardCap = Number(budget?.limits?.llmTokens) || 0;
  const min = Number(minLlmTokens ?? targetLlmTokens ?? budget?.minLlmTokens ?? budget?.targetLlmTokens) || 0;
  const reservedTotal = Number(budget?.reservedReportTotalTokens ?? budget?.reserveReportTokens) || 0;
  const reservedOutput = Number(budget?.maxReportOutputTokens ?? budget?.reserveReportTokens) || 0;
  const estimatedPrompt = Number(budget?.estimatedReportPromptTokens) || 0;
  const remainingVsHardCap = hardCap > 0 ? Math.max(0, hardCap - used) : null;
  const remainingVsMin = min > 0 ? Math.max(0, min - used) : null;
  const belowMin = min > 0 && used < min;
  const minReached = min === 0 || used >= min;
  const hardCapReached = hardCap > 0 && remainingVsHardCap !== null && remainingVsHardCap <= reservedTotal;
  const unusedBudgetTokens = hardCap > 0 ? remainingVsHardCap : remainingVsMin;

  return {
    usedLlmTokens: used,
    hardCapLlmTokens: hardCap || null,
    minLlmTokens: min || null,
    targetLlmTokens: min || null,
    remainingVsHardCap,
    remainingVsMin,
    remainingVsTarget: remainingVsMin,
    reservedReportTokens: reservedTotal,
    reservedReportOutputTokens: reservedOutput,
    estimatedReportPromptTokens: estimatedPrompt,
    belowMin,
    minReached,
    nearTarget: false,
    targetReached: false,
    hardCapReached,
    unusedBudgetTokens,
    actionCostEstimates: actionCosts?.snapshot?.() || {
      search: { estimatedTokens: ACTION_PRIORS.search, samples: 0 },
      read: { estimatedTokens: ACTION_PRIORS.read, samples: 0 },
      reflect: { estimatedTokens: ACTION_PRIORS.reflect, samples: 0 },
      answer: { estimatedTokens: ACTION_PRIORS.answer, samples: 0 },
    },
  };
}
