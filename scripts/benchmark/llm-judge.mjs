const VALID_VERDICTS = new Set([
  'supported',
  'partially_supported',
  'unsupported',
  'unverifiable',
]);

function buildJudgePrompt(claim, resolvedSources) {
  const sourceBlock = resolvedSources.map((entry) => {
    const source = entry.source || {};
    const passage = entry.passage || {};
    const evidence = passage.text
      || passage.excerpt
      || source.summary
      || source.content
      || source.snippet
      || '';
    return [
      entry.key,
      `Title: ${source.title || ''}`,
      `URL: ${source.url || ''}`,
      `Evidence: ${evidence}`,
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

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    const verdict = jsonMatch[0].match(/"verdict"\s*:\s*"([^"]+)"/)?.[1];
    const confidence = jsonMatch[0].match(/"confidence"\s*:\s*("?[\w.]+"?)/)?.[1];
    const reason = jsonMatch[0].match(/"reason"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1];
    if (!verdict) throw new Error('LLM judge response contained invalid JSON.');
    parsed = { verdict, confidence, reason };
  }

  const verdict = String(parsed.verdict || '').trim();
  if (!VALID_VERDICTS.has(verdict)) {
    throw new Error(`Invalid verdict from LLM judge: ${parsed.verdict}`);
  }

  const confidence = normalizeConfidence(parsed.confidence);
  return {
    verdict,
    confidence,
    reason: String(parsed.reason || '').trim(),
  };
}

function normalizeConfidence(raw) {
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return Math.max(0, Math.min(1, numeric));

  const label = String(raw || '').trim().toLowerCase();
  if (label === 'high') return 0.85;
  if (label === 'medium' || label === 'med') return 0.6;
  if (label === 'low') return 0.35;
  return 0;
}

async function completeJudgeResponse(llm, messages) {
  const request = {
    messages,
    temperature: 0,
    maxTokens: 1024,
  };

  if (typeof llm.completeWithMetadata === 'function') {
    const result = await llm.completeWithMetadata(request);
    if (result.text?.trim()) return result.text;
    if (result.metadata?.hasReasoningContent) {
      throw new Error('LLM judge returned reasoning-only output; increase maxTokens for judge calls.');
    }
    throw new Error(`LLM judge returned empty content (finishReason=${result.finishReason || 'unknown'}).`);
  }

  return llm.complete({ ...request, maxTokens: 512 });
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

  try {
    const raw = await completeJudgeResponse(llm, buildJudgePrompt(claim, ruleResult.resolvedSources));
    return {
      ...parseJudgeResponse(raw),
      skipped: false,
    };
  } catch (error) {
    return {
      verdict: 'unverifiable',
      confidence: 0,
      reason: `LLM judge failed: ${error.message}`,
      skipped: false,
    };
  }
}
