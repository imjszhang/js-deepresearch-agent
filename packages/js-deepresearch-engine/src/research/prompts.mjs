import { getSourceEvidence, getSourceEvidenceClass } from './focused-settings.mjs';

export function questionPrompt({ query, count, mode = 'initial', context = '' }) {
  const modeInstructions = {
    initial: `Break this research topic into ${count} focused web search questions:`,
    followup: [
      `Generate ${count} follow-up web search questions that address gaps or next steps.`,
      'Use the prior search evidence as context, but do not repeat previous questions.',
    ].join(' '),
    rapid: [
      `Generate ${count} fast follow-up web search questions.`,
      'Favor broad coverage and concise queries that can be answered from search snippets.',
    ].join(' '),
  };

  return [
    {
      role: 'system',
      content: [
        'You are a research planner. Return only a JSON array of concise search questions.',
        'When the topic concerns software, open-source projects, standards, scientific claims, or product behavior, include at least one question aimed at primary sources such as official documentation, repositories, specifications, or papers.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        modeInstructions[mode] || modeInstructions.initial,
        '',
        `Research topic:\n${query}`,
        context ? `\nContext:\n${context}` : '',
      ].join('\n'),
    },
  ];
}

function sourceEvidenceClassLabel(source) {
  const evidenceClass = getSourceEvidenceClass(source);
  if (evidenceClass === 'source_body') return 'source body';
  if (evidenceClass === 'source_summary') return 'source summary';
  if (evidenceClass === 'snippet_only') return 'search snippet only';
  return 'missing evidence';
}

export function reportPrompt({ query, findings, limitations = [], strategy = 'focused' }) {
  const sourceBlock = findings.map((finding, index) => {
    const sources = finding.sources.map((source, sourceIndex) => (
      `[${index + 1}.${sourceIndex + 1}] ${source.title}\n${source.url}\nEvidence class: ${sourceEvidenceClassLabel(source)}\nEvidence: ${getSourceEvidence(source)}`
    )).join('\n\n');
    return `Question: ${finding.question}\nSources:\n${sources}`;
  }).join('\n\n---\n\n');

  const snippetPolicy = strategy === 'quick'
    ? 'This is a quick snippet-only scan; you may cite search snippets, but do not invent body-level evidence.'
    : [
      'Search snippets are only for discovery and limitations.',
      'Do not treat a snippet-only source as sufficient support for a Summary or Key Findings fact.',
      'If a fact is only backed by a search snippet, omit it from Summary/Key Findings or mark it Unverified and list it under Caveats.',
    ].join(' ');

  return [
    {
      role: 'system',
      content: [
        'You write concise deep research reports in Markdown.',
        'Use citations like [1.1] or [1.2, 2.3] when referencing sources.',
        'Write one verifiable fact per sentence or bullet. Do not pack independent facts into one sentence.',
        'Include: Summary, Key Findings, Evidence, Caveats, Sources.',
        'Only use facts supported by the Evidence blocks.',
        snippetPolicy,
        'If evidence is insufficient, say so in Caveats instead of inventing details.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `Research query:\n${query}`,
        limitations.length ? `Quality constraints:\n${limitations.map((item) => `- ${item}`).join('\n')}\nDo not state these unsupported areas as established facts.` : '',
        `Collected evidence:\n${sourceBlock}`,
      ].filter(Boolean).join('\n\n'),
    },
  ];
}

export function reportRetryPrompt({ query, findings, limitations = [], strategy = 'focused' }) {
  const messages = reportPrompt({ query, findings, limitations, strategy });
  return [
    ...messages,
    {
      role: 'user',
      content: 'The previous response contained no usable final report. Return the final Markdown report now. Do not return analysis, reasoning, JSON, or an empty response.',
    },
  ];
}
