import { getSourceEvidenceClass } from './focused-settings.mjs';
import { DEFAULT_MAX_PASSAGE_CHARS, selectDisplayedEvidence } from './evidence-chain.mjs';
import { partitionFindingsForReport } from './report-evidence.mjs';

export function searchQueryPlannerPrompt({
  mode = 'initial',
  query = '',
  gap = null,
  gaps = [],
  brief = {},
  readiness = null,
  limit = 3,
  searchedQueries = [],
  rejectedQueries = [],
  exhaustedAngles = [],
  observedHosts = [],
  allowedSiteHosts = [],
  evidenceScope = 'web',
  siteQueryMode = 'confirmed',
  siteFallbackFor = '',
  context = '',
  hints = [],
  rejectionReasons = [],
  recentSearchOutcomes = [],
  providerCapabilities = null,
} = {}) {
  const schema = '{"queries":[{"query":"...","targetGapId":"gap-1","intent":"...","expectedEvidence":"...","sourceType":"web|news|filing|local","searchOptions":{"engines":"...","categories":"...","language":"...","pageno":1}}]}';
  return [
    {
      role: 'system',
      content: [
        'You write natural-language web search queries for a research agent.',
        `Return JSON only: ${schema}`,
        `Write at most ${limit} complementary queries. Do not paraphrase.`,
        'Write queries a human would type into a search engine. Match the language of the research question and target sources.',
        'Never copy internal identifiers, snake_case slot names, evidenceCriteria codes, or English boilerplate such as "primary source evidence".',
        'Do not invent or rewrite queries by concatenating slot names, hosts, or missing-evidence codes.',
        'site: is optional. Use it only for hosts listed in allowedSiteHosts. preferredHosts are ranking hints, not site: targets unless they appear in allowedSiteHosts.',
        'searchOptions are optional request parameters passed through to the search provider. Use them only when they appear in providerCapabilities.supportedSearchOptions. A fixedEngine provider will ignore unsupported engines.',
        'Read recentSearchOutcomes as facts. Do not repeat a failed angle unchanged.',
        evidenceScope === 'local' ? 'Local corpus search is active. Never emit site: operators.' : '',
        siteQueryMode === 'never' ? 'Do not emit site: operators in this mode.' : '',
        mode === 'site_fallback' ? 'The previous site: query returned only off-host results. Rewrite it without any site: operator.' : '',
        mode === 'challenge' ? 'Write a challenge query that looks for counter-evidence or an alternative explanation, still in natural language.' : '',
        mode === 'repair' || mode === 'recovery' ? 'Change the search angle, source type, time range, or wording. Do not repeat rejected or searched queries.' : '',
        'Hints are optional ideas only. Rewrite them; do not execute them unchanged if they contain identifiers or templates.',
      ].filter(Boolean).join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        mode,
        query,
        gap,
        gaps,
        brief,
        readiness,
        limit,
        searchedQueries,
        rejectedQueries,
        exhaustedAngles,
        recentSearchOutcomes,
        providerCapabilities,
        observedHosts,
        allowedSiteHosts,
        evidenceScope,
        siteQueryMode,
        siteFallbackFor: siteFallbackFor || null,
        context: context || null,
        hints,
        rejectionReasons,
      }),
    },
  ];
}

export function searchQueryPlannerRetryPrompt(args = {}) {
  const messages = searchQueryPlannerPrompt(args);
  return [
    ...messages,
    {
      role: 'user',
      content: [
        'The previous queries were empty, duplicated, contained internal identifiers, used a forbidden template, or violated site:/local policy.',
        'Return a complete JSON object with new natural-language queries only.',
        args.rejectionReasons?.length ? `Rejection reasons: ${args.rejectionReasons.join(', ')}` : '',
      ].filter(Boolean).join(' '),
    },
  ];
}

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

function formatFindingBlock(finding, index, { passages, maxPassageChars }) {
  const sources = (finding.sources || []).map((source, sourceIndex) => (
    `[${index + 1}.${sourceIndex + 1}] ${source.title}\n${source.url}\nEvidence class: ${sourceEvidenceClassLabel(source)}\nEvidence: ${selectDisplayedEvidence(source, { passages, maxChars: maxPassageChars })}`
  )).join('\n\n');
  return `Question: ${finding.question}\nEvidence grade: ${finding.evidenceGrade || 'verified'}\nSources:\n${sources}`;
}

const NARRATIVE_SCHEMA = '{"title":"...","summary":["... [1.1]"],"keyFindings":[{"heading":"...","claims":["... [1.2]"]}],"caveats":["..."]}';
const REPORT_FINDING_INDEX = Symbol('reportFindingIndex');

export function reportPrompt({
  query,
  findings,
  limitations = [],
  strategy = 'focused',
  passages = [],
  maxPassageChars = DEFAULT_MAX_PASSAGE_CHARS,
  gaps = [],
} = {}) {
  const indexedFindings = findings.map((finding, index) => ({
    ...finding,
    [REPORT_FINDING_INDEX]: index,
  }));
  const partitioned = partitionFindingsForReport({ findings: indexedFindings, gaps, strategy });
  const verifiedBlock = partitioned.verified.map((finding) => (
    formatFindingBlock(finding, finding[REPORT_FINDING_INDEX], { passages, maxPassageChars })
  )).join('\n\n---\n\n');
  const limitedBlock = partitioned.limited.map((finding) => (
    formatFindingBlock(finding, finding[REPORT_FINDING_INDEX], { passages, maxPassageChars })
  )).join('\n\n---\n\n');
  const blockedBlock = partitioned.blocked.map((finding) => (
    `${finding.question} [${finding.gapId || 'unresolved'}] status=${finding.evidenceGrade}`
  )).join('\n');

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
        'You write only the narrative of a deep research report as JSON.',
        `Return exactly this shape: ${NARRATIVE_SCHEMA}`,
        'Use citations like [1.1] or [1.2, 2.3] when referencing sources.',
        'Write one verifiable fact per summary item or key-finding claim.',
        'Do not include evidence, sources, Evidence, or Sources fields.',
        'Do not copy Evidence class labels or source-body dumps into claims.',
        'The runtime appends Evidence and Sources from collected findings.',
        'Only verified/resolved evidence may enter Summary or Key Findings as confirmed facts.',
        'Limited or body_read evidence may only appear in Caveats with hedging language.',
        'Blocked, missing, open, or searched slots are gap notes only and must not be written as confirmed evidence.',
        snippetPolicy,
        'If evidence is insufficient, say so in caveats instead of inventing details.',
        'Finish every sentence. Do not stop mid-clause or mid-citation.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `Research query:\n${query}`,
        limitations.length ? `Quality constraints:\n${limitations.map((item) => `- ${item}`).join('\n')}\nDo not state these unsupported areas as established facts.` : '',
        verifiedBlock ? `Verified evidence (may support Summary/Key Findings):\n${verifiedBlock}` : 'Verified evidence: none.',
        limitedBlock ? `Limited evidence (Caveats only, hedge every claim):\n${limitedBlock}` : '',
        blockedBlock ? `Unresolved or blocked slots (gap notes only, do not confirm):\n${blockedBlock}` : '',
      ].filter(Boolean).join('\n\n'),
    },
  ];
}

export function claimEntailmentPrompt({ claim, passages = [] }) {
  const passageBlock = passages.map((passage, index) => {
    const assessment = formatAssessment(passage.assessment);
    return [`[P${index + 1}] ${passage.text}`, assessment].filter(Boolean).join('\n');
  }).join('\n\n');
  return [
    {
      role: 'system',
      content: [
        'Judge whether the cited source passages entail the claim.',
        'Return JSON only: {"verdict":"supported|partially_supported|unsupported|unverifiable","quote":"..."}',
        'supported: a passage clearly states the claim. partially_supported: a passage supports only part of it.',
        'unsupported: a passage contradicts the claim. unverifiable: the passages do not decide it.',
        'quote must be a verbatim excerpt copied from one passage. Do not invent quotes.',
        'If a passage includes source assessment metadata, consider whether that publisher and content type can support the claim as written.',
      ].join(' '),
    },
    {
      role: 'user',
      content: `Claim:\n${claim.text}\n\nCited passages:\n${passageBlock}`,
    },
  ];
}

export function gapSlotSupportPrompt({ query, slots = [], compact = false } = {}) {
  const slotBlock = slots.map(({ gap, passages = [] }, index) => {
    const passageBlock = passages.map((passage, passageIndex) => {
      const assessment = formatAssessment(passage.assessment);
      return [`[${gap.id}:P${passageIndex + 1} id=${passage.id}] ${passage.text}`, assessment].filter(Boolean).join('\n');
    }).join('\n\n');
    return [
      `Slot ${index + 1}`,
      `gapId: ${gap.id}`,
      `answerSlot: ${gap.answerSlot || gap.question}`,
      `question: ${gap.question}`,
      gap.evidenceCriteria?.length ? `evidenceCriteria: ${gap.evidenceCriteria.join('; ')}` : '',
      `passages:\n${passageBlock}`,
      passages.some((passage) => passage.assessment)
        ? 'Each passage may include source assessment metadata from the read step. Use it when judging whether the evidence type can answer the slot.'
        : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  const schema = compact
    ? '{"judgments":[{"gapId":"...","verdict":"supported|partially_supported|unsupported|unverifiable|conflicting","quote":"...","supportingPassageIds":[],"reason":"..."}]}'
    : '{"judgments":[{"gapId":"...","answerSlot":"...","verdict":"supported|partially_supported|unsupported|unverifiable|conflicting","quote":"...","supportingPassageIds":[],"contradictingPassageIds":[],"reason":"..."}]}';
  return [
    {
      role: 'system',
      content: [
        'Judge whether the successful source-body passages support each required answer slot for THIS query.',
        `Return JSON only: ${schema}`,
        'supported: a passage clearly answers the slot. partially_supported: only part of the slot is answered.',
        'unsupported: passages do not answer the slot. conflicting: passages disagree. unverifiable: cannot decide.',
        'quote must be a verbatim excerpt copied from one provided passage. Do not invent quotes.',
        'Do not use search snippets. Embedding scores are only for ranking, not for closing a slot.',
        'If a passage includes source assessment metadata, weigh publisher type and content kind together with the quoted text.',
      ].join(' '),
    },
    {
      role: 'user',
      content: `Query:\n${query}\n\n${slotBlock}`,
    },
  ];
}

export function sourceAssessmentPrompt({
  query = '',
  question = '',
  title = '',
  url = '',
  content = '',
  entities = [],
  preferredHosts = [],
  observedHosts = [],
} = {}) {
  const schema = '{"summary":"...","readability":"readable|unreadable|uncertain","contentKind":"article|homepage|product_page|filing|forum|login_wall|error_page|obfuscated|other","publisherType":"official|regulator|exchange_filing|mainstream_media|aggregator|reseller|mirror|ugc|unknown","firstParty":false,"evidenceTier":"other_primary|specialist|mainstream|reprint|ugc|unknown","reason":"..."}';
  return [
    {
      role: 'system',
      content: [
        'Assess one fetched page for a research agent.',
        `Return JSON only: ${schema}`,
        'summary must be plain facts relevant to the research query, or empty if the page is unreadable.',
        'readability=unreadable when the body is a WAF shell, captcha, encrypted blob, login wall, or otherwise not human-readable article text.',
        'Do not invent facts. firstParty is true only when the page is published by the researched entity itself.',
        'evidenceTier must be one of the listed values. Never emit required_primary.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Research query: ${query}`,
        question ? `Focus question: ${question}` : '',
        `Source title: ${title}`,
        `Source URL: ${url}`,
        entities.length ? `Entities: ${entities.join(', ')}` : '',
        preferredHosts.length ? `Preferred hosts: ${preferredHosts.join(', ')}` : '',
        observedHosts.length ? `Observed hosts: ${observedHosts.slice(0, 12).join(', ')}` : '',
        '',
        'Page content:',
        content,
      ].filter(Boolean).join('\n'),
    },
  ];
}

function formatAssessment(assessment) {
  if (!assessment || typeof assessment !== 'object') return '';
  return `Source assessment: readability=${assessment.readability || 'unknown'}; contentKind=${assessment.contentKind || 'unknown'}; publisherType=${assessment.publisherType || 'unknown'}; firstParty=${assessment.firstParty === true}; evidenceTier=${assessment.evidenceTier || 'unknown'}`;
}

export function reportRetryPrompt({
  query,
  findings,
  limitations = [],
  strategy = 'focused',
  passages = [],
  maxPassageChars = DEFAULT_MAX_PASSAGE_CHARS,
  gaps = [],
} = {}) {
  const messages = reportPrompt({ query, findings, limitations, strategy, passages, maxPassageChars, gaps });
  return [
    ...messages,
    {
      role: 'user',
      content: 'The previous narrative was unusable, truncated, incomplete, or not valid JSON. Return a complete Markdown narrative now with a title, Summary, and Key Findings. Finish every sentence. Do not write Evidence or Sources sections. Do not copy source-body dumps. Do not return analysis or an empty response.',
    },
  ];
}
