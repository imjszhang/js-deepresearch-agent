import { getSourceEvidence } from './focused-settings.mjs';

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

export function reportPrompt({ query, findings, limitations = [] }) {
  const sourceBlock = findings.map((finding, index) => {
    const sources = finding.sources.map((source, sourceIndex) => (
      `[${index + 1}.${sourceIndex + 1}] ${source.title}\n${source.url}\nEvidence: ${getSourceEvidence(source)}`
    )).join('\n\n');
    return `Question: ${finding.question}\nSources:\n${sources}`;
  }).join('\n\n---\n\n');

  return [
    {
      role: 'system',
      content: [
        'You write concise deep research reports in Markdown.',
        'Use citations like [1.1] when referencing sources.',
        'Include: Summary, Key Findings, Evidence, Caveats, Sources.',
        'Only use facts supported by the Evidence blocks.',
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

export function reportRetryPrompt({ query, findings, limitations = [] }) {
  const messages = reportPrompt({ query, findings, limitations });
  return [
    ...messages,
    {
      role: 'user',
      content: 'The previous response contained no usable final report. Return the final Markdown report now. Do not return analysis, reasoning, JSON, or an empty response.',
    },
  ];
}
