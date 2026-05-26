const VALID_VERDICTS = new Set([
  'supported',
  'partially_supported',
  'unsupported',
  'unverifiable',
]);

function buildJudgePrompt(claim, resolvedSources) {
  const sourceBlock = resolvedSources.map((entry) => {
    const source = entry.source || {};
    return [
      entry.key,
      `Title: ${source.title || ''}`,
      `URL: ${source.url || ''}`,
      `Snippet: ${source.snippet || ''}`,
      `Engine: ${source.engine || ''}`,
    ].join('\n');
  }).join('\n\n');

  return [
    {
      role: 'system',
      content: [
        'You evaluate whether a research report claim is supported by cited sources.',
        'Return only JSON with keys: verdict, confidence, reason.',
        'verdict must be one of: supported, partially_supported, unsupported, unverifiable.',
        'confidence must be a number between 0 and 1.',
        'reason must be a short Chinese explanation.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        'Claim:',
        claim.text,
        '',
        'Cited sources:',
        sourceBlock || '(none)',
      ].join('\n'),
    },
  ];
}

function parseJudgeResponse(raw = '') {
  const trimmed = String(raw).trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('LLM judge response did not contain JSON.');
  }

  const parsed = JSON.parse(jsonMatch[0]);
  const verdict = String(parsed.verdict || '').trim();
  if (!VALID_VERDICTS.has(verdict)) {
    throw new Error(`Invalid verdict from LLM judge: ${parsed.verdict}`);
  }

  const confidence = Number(parsed.confidence);
  return {
    verdict,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    reason: String(parsed.reason || '').trim(),
  };
}

export async function judgeClaimWithLlm(claim, ruleResult, llm) {
  if (!llm) {
    return {
      verdict: 'unverifiable',
      confidence: 0,
      reason: 'LLM judge disabled.',
      skipped: true,
    };
  }

  if (!ruleResult.hasCitations || ruleResult.resolvedSources.length === 0) {
    return {
      verdict: 'unverifiable',
      confidence: 0.9,
      reason: '缺少可解析引用，无法判分。',
      skipped: false,
    };
  }

  const raw = await llm.complete({
    messages: buildJudgePrompt(claim, ruleResult.resolvedSources),
    temperature: 0,
    maxTokens: 300,
  });

  return {
    ...parseJudgeResponse(raw),
    skipped: false,
  };
}
