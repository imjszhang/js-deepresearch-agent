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
      content: 'You are a research planner. Return only a JSON array of concise search questions.',
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

export function reportPrompt({ query, findings }) {
  const sourceBlock = findings.map((finding, index) => {
    const sources = finding.sources.map((source, sourceIndex) => (
      `[${index + 1}.${sourceIndex + 1}] ${source.title}\n${source.url}\n${source.snippet}`
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
      ].join(' '),
    },
    {
      role: 'user',
      content: `Research query:\n${query}\n\nCollected evidence:\n${sourceBlock}`,
    },
  ];
}
