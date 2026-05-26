import { createLlmProvider } from '../llm/provider-factory.mjs';
import { createSearchEngine } from '../search/search-factory.mjs';
import { createProgressEmitter } from './progress-events.mjs';
import { buildReport } from './report-builder.mjs';
import { runStrategy } from './strategies.mjs';

export class ResearchRunner {
  async run({ query, settings, signal, onProgress = () => {}, llm: providedLlm, search: providedSearch }) {
    const llm = providedLlm || createLlmProvider(settings);
    const search = providedSearch || createSearchEngine(settings);
    const strategy = settings.research.strategy || 'source-based';
    const emit = createProgressEmitter(onProgress);

    emit({ stage: 'research_started' });
    const findings = await runStrategy({
      strategy,
      query,
      settings,
      llm,
      search,
      signal,
      emit,
    });

    emit({ stage: 'synthesizing_report' });
    const report = await buildReport({ llm, query, findings, signal });
    emit({ stage: 'research_complete' });

    return {
      report,
      findings,
      sources: flattenSources(findings),
    };
  }
}

function flattenSources(findings) {
  const seen = new Set();
  const sources = [];
  for (const finding of findings) {
    for (const source of finding.sources) {
      const key = source.url || `${source.title}:${source.snippet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(source);
    }
  }
  return sources;
}
