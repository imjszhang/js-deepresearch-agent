import { sourceMatchesPolicy, registrableDomain } from './source-policy.mjs';

export { sourceMatchesPolicy, registrableDomain };

function compiled(patterns = []) {
  return patterns.map((pattern) => {
    if (pattern instanceof RegExp) {
      const flags = pattern.flags.replaceAll('g', '');
      return flags === pattern.flags ? pattern : new RegExp(pattern.source, flags);
    }
    return new RegExp(pattern, 'i');
  });
}

function normalizeSlot(slot) {
  return {
    required: false,
    critical: false,
    minSources: 0,
    sourcePolicy: null,
    maxAgeDays: null,
    requiresNumbers: false,
    minIndependentDomains: 0,
    numberNames: [],
    patternMode: 'any',
    ...slot,
    patterns: compiled(slot.patterns || []),
  };
}

function battery({ id, match, sourcePolicies = {}, slots = [] }) {
  return {
    id,
    match,
    sourcePolicies,
    slots: slots.map((slot) => normalizeSlot(slot)),
  };
}

const POSITIONING = /定位|official|first-class|一等公民|封装|框架|后端|原生/i;
const PERFORMANCE = /性能|吞吐|延迟|tok\/s|tokens?\/s(?:ec)?|快\s*\d|\d+\s*%|2\s*倍/i;
const USAGE = /推荐|用法|mlx-lm|llama (?:cli|serve)|ollama (?:run|launch)|选型/i;

export const QUERY_BATTERIES = [
  battery({
    id: 'apple-silicon-local-llm',
    match: (query) => /llama\.cpp/i.test(query) && /\bmlx\b/i.test(query) && /\bollama\b/i.test(query),
    sourcePolicies: {
      llamacpp_official: [{ host: 'github.com', pathPrefix: '/ggml-org/' }],
      mlx_official: [
        { host: 'github.com', pathPrefix: '/ml-explore/' },
        { host: 'developer.apple.com' },
      ],
      ollama_official: [
        { host: 'ollama.com' },
        { host: 'github.com', pathPrefix: '/ollama/' },
      ],
    },
    slots: [
      {
        id: 'llamacpp.positioning',
        label: 'llama.cpp official positioning',
        required: true,
        critical: true,
        minSources: 1,
        sourcePolicy: 'llamacpp_official',
        patterns: [/llama\.cpp/i, POSITIONING],
        patternMode: 'all',
      },
      {
        id: 'mlx.positioning',
        label: 'MLX official positioning',
        required: true,
        critical: true,
        minSources: 1,
        sourcePolicy: 'mlx_official',
        patterns: [/\bmlx\b/i, POSITIONING],
        patternMode: 'all',
      },
      {
        id: 'ollama.positioning',
        label: 'Ollama official positioning',
        required: true,
        critical: true,
        minSources: 1,
        sourcePolicy: 'ollama_official',
        patterns: [/\bollama\b/i, POSITIONING],
        patternMode: 'all',
      },
      {
        id: 'llamacpp.performance',
        label: 'llama.cpp performance',
        required: true,
        critical: true,
        minSources: 1,
        requiresNumbers: true,
        patterns: [/llama\.cpp/i, PERFORMANCE],
        patternMode: 'all',
        numberNames: ['throughput'],
      },
      {
        id: 'mlx.performance',
        label: 'MLX performance',
        required: true,
        critical: true,
        minSources: 1,
        requiresNumbers: true,
        patterns: [/\bmlx\b/i, PERFORMANCE],
        patternMode: 'all',
        numberNames: ['throughput'],
      },
      {
        id: 'ollama.performance',
        label: 'Ollama performance',
        required: true,
        critical: true,
        minSources: 1,
        requiresNumbers: true,
        patterns: [/\bollama\b/i, PERFORMANCE],
        patternMode: 'all',
        numberNames: ['throughput'],
      },
      {
        id: 'usage.recommendation',
        label: 'Recommended usage',
        required: true,
        critical: true,
        minSources: 1,
        patterns: [USAGE],
      },
    ],
  }),
  battery({
    id: 'zhipu-equity-investment',
    match: (query) => /智谱|zhipu/i.test(query) && /投资|估值|融资/.test(query),
    sourcePolicies: {
      regulatory: [
        { host: 'www.hkexnews.hk' },
        { host: 'hkexnews.hk' },
        { host: 'www1.hkexnews.hk' },
      ],
      company: [
        { host: 'www.zhipuai.cn' },
        { host: 'zhipuai.cn' },
        { host: 'www.bigmodel.cn' },
        { host: 'bigmodel.cn' },
      ],
    },
    slots: [
      {
        id: 'company.listing',
        label: 'Company listing / identity',
        required: true,
        critical: true,
        minSources: 1,
        sourcePolicy: 'regulatory',
        patterns: [/上市|港股|港交所|股份代号|股票代码|02513|HKEX|listing/i],
      },
      {
        id: 'company.control',
        label: 'Control / major shareholders',
        required: true,
        critical: true,
        minSources: 1,
        sourcePolicy: 'regulatory',
        patterns: [/控股|股东|股权结构|实控|majority shareholder|controlling/i],
      },
      {
        id: 'company.financing',
        label: 'Historical financing / current equity',
        required: true,
        critical: true,
        minSources: 1,
        patterns: [/融资|轮次|估值|股权|investment|valuation|series [a-d]/i],
      },
      {
        id: 'financials.revenue',
        label: 'Latest audited revenue',
        required: true,
        critical: true,
        minSources: 1,
        sourcePolicy: 'regulatory',
        requiresNumbers: true,
        minIndependentDomains: 1,
        numberNames: ['revenue'],
        patterns: [/营收|收入|revenue|营业额/i],
      },
      {
        id: 'financials.gross_profit',
        label: 'Gross profit',
        required: false,
        critical: true,
        minSources: 1,
        sourcePolicy: 'regulatory',
        requiresNumbers: true,
        numberNames: ['gross_profit'],
        patterns: [/毛利|gross profit/i],
      },
      {
        id: 'financials.loss',
        label: 'Profit or loss',
        required: false,
        critical: true,
        minSources: 1,
        requiresNumbers: true,
        numberNames: ['loss'],
        patterns: [/亏损|净亏损|净利|loss|profit/i],
      },
      {
        id: 'financials.segment',
        label: 'Segment / customer concentration',
        required: false,
        critical: true,
        minSources: 1,
        patterns: [/分部|业务板块|客户集中|concentration|segment/i],
      },
      {
        id: 'financials.cash',
        label: 'Cash / cash burn / runway',
        required: false,
        critical: true,
        minSources: 1,
        requiresNumbers: true,
        numberNames: ['cash'],
        patterns: [/现金|账面|burn|runway|现金流/i],
      },
      {
        id: 'market.price',
        label: 'Current price / market cap with as-of date',
        required: true,
        critical: true,
        minSources: 1,
        requiresNumbers: true,
        maxAgeDays: 180,
        numberNames: ['price', 'market_cap'],
        patterns: [/股价|市值|price|market cap|截至|as-of|as of/i],
      },
      {
        id: 'market.placing',
        label: 'Placing / dilution / lockup',
        required: false,
        critical: true,
        minSources: 1,
        patterns: [/配售|稀释|限售|lock-?up|dilution|placing/i],
      },
      {
        id: 'product.glm',
        label: 'Product / GLM',
        required: true,
        critical: true,
        minSources: 1,
        sourcePolicy: 'company',
        patterns: [/\bglm\b/i, /chatglm/i, /清言/],
      },
      {
        id: 'commercial.customers',
        label: 'Commercialization / customers',
        required: false,
        critical: true,
        minSources: 1,
        patterns: [/商业化|客户|合同|定价|arr/i],
      },
      {
        id: 'market.competitors',
        label: 'Competitors',
        required: false,
        critical: true,
        minSources: 1,
        minIndependentDomains: 1,
        patterns: [/deepseek/i, /深度求索/, /moonshot/i, /月之暗面/, /阿里/, /alibaba/i, /字节/, /bytedance/i],
      },
      {
        id: 'regulatory.filings',
        label: 'Regulation / filing / sanctions',
        required: false,
        critical: true,
        minSources: 1,
        sourcePolicy: 'regulatory',
        patterns: [/监管|备案|制裁|合规|filing|sanctions?/i],
      },
      {
        id: 'company.management',
        label: 'Management / related-party',
        required: false,
        critical: true,
        minSources: 1,
        patterns: [/管理层|董事|关联交易|related-?party|management/i],
      },
      {
        id: 'thesis.catalysts',
        label: 'Bull / bear catalysts',
        required: false,
        critical: true,
        minSources: 0,
        patterns: [/催化剂|看多|看空|bull|bear|上行|下行/i],
      },
      {
        id: 'disclosure.gaps',
        label: 'Missing data / open questions',
        required: true,
        critical: true,
        minSources: 0,
        patterns: [/^#{1,6}\s+.*(gaps?|limitations?|open questions?|局限|限制|未决|开放问题|信息缺口|风险提示)/im],
      },
    ],
  }),
  battery({
    id: 'definitional-single-subject',
    match: (query) => /^what is \w+/i.test(String(query || '').trim()),
    sourcePolicies: {},
    slots: [
      {
        id: 'definition.present',
        label: 'Definition present',
        required: true,
        critical: false,
        minSources: 0,
        patterns: [/is a/i, /是/, /local/i, /本地/, /runner/i, /framework/i, /引擎/, /框架/],
      },
      {
        id: 'definition.cited_source',
        label: 'At least one cited source',
        required: true,
        critical: false,
        minSources: 1,
        patterns: [/is a/i, /是/, /local/i, /本地/, /runner/i, /framework/i, /引擎/, /框架/],
      },
    ],
  }),
];

export function matchQueryBattery(query = '') {
  return QUERY_BATTERIES.find((item) => item.match(query)) || null;
}

export function hitsPatterns(text, patterns = []) {
  const value = String(text || '');
  return (patterns || []).some((pattern) => pattern.test(value));
}

export function hitsAllPatterns(text, patterns = []) {
  const value = String(text || '');
  const list = patterns || [];
  return list.length > 0 && list.every((pattern) => pattern.test(value));
}

export function slotPatternsHit(text, slot) {
  if (!slot) return false;
  return slot.patternMode === 'all'
    ? hitsAllPatterns(text, slot.patterns)
    : hitsPatterns(text, slot.patterns);
}
