export function questionPrompt(query, count) {
  return [
    {
      role: 'system',
      content: 'You are a research planner. Return only a JSON array of concise search questions.',
    },
    {
      role: 'user',
      content: `Break this research topic into ${count} focused web search questions:\n\n${query}`,
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
