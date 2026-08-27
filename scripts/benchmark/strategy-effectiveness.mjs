import {
  calculateQualityMetrics,
  extractQualityClaims,
  getSourceEvidenceClass,
  keepNarrativeSections,
  sourceHasFetchedBody,
} from 'js-deepresearch-engine';
import { hitsPatterns, matchQueryBattery } from './query-battery.mjs';

const OFFICIAL_HOSTS = [
  /github\.com\/ggml-org/i,
  /github\.com\/ml-explore/i,
  /github\.com\/ollama/i,
  /ollama\.com/i,
  /llama\.app/i,
  /developer\.apple\.com/i,
];

function rate(numerator, denominator) {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(4));
}

function narrativeText(report = '', query = '') {
  return keepNarrativeSections(report, { query }) || String(report || '').split(/^##\s+(Evidence|证据)\b/im)[0] || '';
}

function splitNarrativeSections(text = '') {
  const sections = [];
  let current = { heading: '', body: '' };
  for (const line of String(text).split('\n')) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      if (current.heading || current.body.trim()) sections.push(current);
      current = { heading: heading[2], body: '' };
      continue;
    }
    current.body += `${line}\n`;
  }
  if (current.heading || current.body.trim()) sections.push(current);
  return sections;
}

export function scoreCoverage(text = '', battery = null) {
  if (!battery) {
    return {
      batteryId: null,
      subjects: [],
      aspects: [],
      cells: [],
      subjectRate: null,
      aspectRate: null,
      cellRate: null,
      coverageRate: null,
    };
  }

  const filled = new Set();
  for (const section of splitNarrativeSections(text)) {
    const bullets = section.body
      .split('\n')
      .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').replace(/^unverified:\s*/i, '').trim())
      .filter((line) => line.length > 4);
    const windows = bullets.length > 0
      ? bullets.map((bullet) => `${section.heading}\n${bullet}`)
      : [`${section.heading}\n${section.body}`];
    for (const windowText of windows) {
      const subjectHits = battery.subjects.filter((subject) => hitsPatterns(windowText, subject.patterns));
      const aspectHits = battery.aspects.filter((aspect) => hitsPatterns(windowText, aspect.patterns));
      for (const subject of subjectHits) {
        for (const aspect of aspectHits) filled.add(`${subject.id}::${aspect.id}`);
      }
    }
  }

  const cells = battery.subjects.flatMap((subject) => battery.aspects.map((aspect) => ({
    subjectId: subject.id,
    aspectId: aspect.id,
    hit: filled.has(`${subject.id}::${aspect.id}`),
  })));
  const subjects = battery.subjects.map((subject) => ({
    id: subject.id,
    label: subject.label,
    hit: hitsPatterns(text, subject.patterns),
    aspectHits: cells.filter((cell) => cell.subjectId === subject.id && cell.hit).length,
  }));
  const aspects = battery.aspects.map((aspect) => ({
    id: aspect.id,
    label: aspect.label,
    hit: hitsPatterns(text, aspect.patterns),
    subjectHits: cells.filter((cell) => cell.aspectId === aspect.id && cell.hit).length,
  }));

  return {
    batteryId: battery.id,
    subjects,
    aspects,
    cells,
    subjectRate: rate(subjects.filter((item) => item.hit).length, subjects.length),
    aspectRate: rate(aspects.filter((item) => item.hit).length, aspects.length),
    cellRate: rate(cells.filter((cell) => cell.hit).length, cells.length),
    coverageRate: rate(cells.filter((cell) => cell.hit).length, cells.length),
  };
}

function sourceHaystack(source = {}) {
  return [source.title, source.url, source.snippet, source.summary, source.content].filter(Boolean).join('\n');
}

export function scoreSubjectEvidence(sources = [], battery = null) {
  if (!battery) {
    return { subjects: [], subjectBodyRate: null, officialSubjectRate: null };
  }
  const bodySources = sources.filter((source) => {
    const klass = getSourceEvidenceClass(source);
    return klass === 'source_body' || klass === 'source_summary' || sourceHasFetchedBody(source);
  });
  const subjects = battery.subjects.map((subject) => {
    const bodyHit = bodySources.some((source) => hitsPatterns(sourceHaystack(source), subject.patterns));
    const officialHit = sources.some((source) => (
      OFFICIAL_HOSTS.some((pattern) => pattern.test(source.url || ''))
      && hitsPatterns(sourceHaystack(source), subject.patterns)
    ));
    return {
      id: subject.id,
      label: subject.label,
      bodyHit,
      officialHit,
    };
  });
  return {
    subjects,
    subjectBodyRate: rate(subjects.filter((item) => item.bodyHit).length, subjects.length),
    officialSubjectRate: rate(subjects.filter((item) => item.officialHit).length, subjects.length),
  };
}

export function scoreEvidenceMix(findings = [], sources = []) {
  const records = sources.length
    ? sources
    : findings.flatMap((finding) => finding.sources || []);
  let body = 0;
  let summary = 0;
  let snippet = 0;
  let official = 0;
  for (const source of records) {
    const klass = getSourceEvidenceClass(source);
    if (klass === 'source_body' || sourceHasFetchedBody(source)) body += 1;
    else if (klass === 'source_summary') summary += 1;
    else snippet += 1;
    if (OFFICIAL_HOSTS.some((pattern) => pattern.test(source.url || ''))) official += 1;
  }
  const total = records.length;
  return {
    sourceCount: total,
    bodySources: body,
    summarySources: summary,
    snippetSources: snippet,
    officialSources: official,
    bodyOrSummaryRate: rate(body + summary, total),
    snippetRate: rate(snippet, total),
    officialRate: rate(official, total),
  };
}

export function scoreNarrativeQuality(report = '', query = '', storedClaims = []) {
  const narrative = narrativeText(report, query);
  const storedKeys = (storedClaims || []).filter((claim) => (
    (claim.kind || 'key_claim') === 'key_claim' && claim.evaluation
  ));
  if (storedKeys.length > 0) {
    return {
      narrativeChars: narrative.length,
      origin: 'stored_key_claims',
      metrics: calculateQualityMetrics(storedKeys),
    };
  }
  return {
    narrativeChars: narrative.length,
    origin: 'extracted',
    metrics: calculateQualityMetrics(extractQualityClaims(narrative).filter((claim) => claim.kind === 'key_claim')),
  };
}

export function evaluateStrategyContract(strategy, { mix, coverage, subjectEvidence, narrative, usage = {} }) {
  const checks = [];
  const subjectCovered = coverage.subjectRate == null || coverage.subjectRate === 1;
  const cellsCovered = coverage.cellRate == null || coverage.cellRate >= 0.67;
  const bodiesBySubject = subjectEvidence?.subjectBodyRate;
  const keyClaims = narrative.metrics.keyClaimCount || 0;

  if (strategy === 'quick') {
    checks.push({
      id: 'snippet_scan',
      pass: (usage.sourceReads || 0) === 0 || mix.bodySources === 0,
      detail: 'Quick should stay snippet-first and not promise body-level evidence.',
    });
    checks.push({
      id: 'names_the_subjects',
      pass: subjectCovered,
      detail: 'Even a scan should mention every subject in a comparison query.',
    });
  } else if (strategy === 'focused') {
    checks.push({
      id: 'reads_bodies',
      pass: mix.bodySources + mix.summarySources > 0,
      detail: 'Focused should read source bodies or summaries.',
    });
    checks.push({
      id: 'reads_each_subject',
      pass: bodiesBySubject == null || bodiesBySubject === 1,
      detail: 'Focused should read a body or summary for every named subject.',
    });
    checks.push({
      id: 'has_narrative_claims',
      pass: keyClaims > 0,
      detail: 'Focused should produce evaluable Summary/Key Findings claims.',
    });
    checks.push({
      id: 'covers_subjects',
      pass: subjectCovered,
      detail: 'A bounded comparison should cover every named subject.',
    });
  } else if (strategy === 'exploratory') {
    checks.push({
      id: 'reads_bodies',
      pass: mix.bodySources + mix.summarySources > 0,
      detail: 'Exploratory should gather body-level evidence.',
    });
    checks.push({
      id: 'reads_each_subject',
      pass: bodiesBySubject == null || bodiesBySubject === 1,
      detail: 'Exploratory should read a body or summary for every named subject.',
    });
    checks.push({
      id: 'covers_subjects',
      pass: subjectCovered,
      detail: 'Open multi-subject research should cover every named subject.',
    });
    checks.push({
      id: 'covers_subject_aspects',
      pass: cellsCovered,
      detail: 'Exploratory should cover every subject × aspect cell, not just name-drop.',
    });
    checks.push({
      id: 'has_narrative_claims',
      pass: keyClaims > 0,
      detail: 'Exploratory should produce a non-empty narrative.',
    });
  }

  return {
    strategy,
    pass: checks.length > 0 && checks.every((check) => check.pass),
    checks,
  };
}

export function scoreStrategyEffectiveness({
  query = '',
  strategy = '',
  report = '',
  findings = [],
  sources = [],
  claims = [],
  usage = {},
} = {}) {
  const battery = matchQueryBattery(query);
  const narrative = scoreNarrativeQuality(report, query, claims);
  const coverage = scoreCoverage(narrativeText(report, query), battery);
  const subjectEvidence = scoreSubjectEvidence(sources, battery);
  const mix = scoreEvidenceMix(findings, sources);
  const rates = narrative.metrics.rates || {};
  const keyClaims = narrative.metrics.keyClaimCount || 0;
  const tokens = Number(usage.llmTokens) || 0;
  const supported = narrative.metrics.claims?.supported || 0;

  return {
    batteryId: battery?.id || null,
    coverage,
    subjectEvidence,
    evidence: {
      ...mix,
      subjectBodyRate: subjectEvidence.subjectBodyRate,
      officialSubjectRate: subjectEvidence.officialSubjectRate,
    },
    narrative: {
      chars: narrative.narrativeChars,
      keyClaimCount: keyClaims,
      evaluatedClaimCount: narrative.metrics.evaluatedClaimCount,
      supported: narrative.metrics.claims?.supported ?? 0,
      partiallySupported: narrative.metrics.claims?.partiallySupported ?? 0,
      unverifiable: narrative.metrics.claims?.unverifiable ?? 0,
      supportedRate: rates.supportedRate,
      supportedOrPartialRate: rates.supportedOrPartialRate,
    },
    efficiency: {
      tokensPerKeyClaim: keyClaims ? Number((tokens / keyClaims).toFixed(1)) : null,
      tokensPerSupportedClaim: supported ? Number((tokens / supported).toFixed(1)) : null,
      tokensPerCoveredSlot: coverage.coverageRate && tokens
        ? Number((tokens / Math.max(1, Math.round(coverage.coverageRate * ((coverage.subjects?.length || 0) + (coverage.aspects?.length || 0))))).toFixed(1))
        : null,
    },
    contract: evaluateStrategyContract(strategy, { mix, coverage, subjectEvidence, narrative, usage }),
  };
}
