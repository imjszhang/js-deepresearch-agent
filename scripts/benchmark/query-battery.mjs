function compiled(patterns) {
  return patterns.map((pattern) => (pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i')));
}

function battery({ id, match, subjects, aspects }) {
  return {
    id,
    match,
    subjects: subjects.map((subject) => ({ ...subject, patterns: compiled(subject.patterns) })),
    aspects: aspects.map((aspect) => ({ ...aspect, patterns: compiled(aspect.patterns) })),
  };
}

export const QUERY_BATTERIES = [
  battery({
    id: 'apple-silicon-local-llm',
    match: (query) => /llama\.cpp/i.test(query) && /\bmlx\b/i.test(query) && /\bollama\b/i.test(query),
    subjects: [
      { id: 'llamacpp', label: 'llama.cpp', patterns: [/llama\.cpp/i] },
      { id: 'mlx', label: 'MLX', patterns: [/\bmlx\b/i] },
      { id: 'ollama', label: 'Ollama', patterns: [/\bollama\b/i] },
    ],
    aspects: [
      { id: 'positioning', label: '官方定位', patterns: [/定位/, /official/, /first-class/, /一等公民/, /封装/, /框架/, /后端/] },
      { id: 'performance', label: '性能取舍', patterns: [/性能/, /吞吐/, /延迟/, /tok\/s/i, /tokens?\/s(?:ec)?/i, /快\s*\d/, /\d+\s*%/] },
      { id: 'usage', label: '推荐用法', patterns: [/推荐/, /用法/, /mlx-lm/i, /llama (?:cli|serve)/i, /ollama (?:run|launch)/i, /选型/] },
    ],
  }),
  battery({
    id: 'definitional-single-subject',
    match: (query) => /^what is \w+/i.test(String(query || '').trim()),
    subjects: [
      { id: 'subject', label: 'query subject', patterns: [/\bollama\b/i, /llama\.cpp/i, /\bmlx\b/i] },
    ],
    aspects: [
      { id: 'definition', label: '定义', patterns: [/local/i, /本地/, /runner/i, /framework/i, /引擎/, /框架/] },
    ],
  }),
];

export function matchQueryBattery(query = '') {
  return QUERY_BATTERIES.find((item) => item.match(query)) || null;
}

export function hitsPatterns(text, patterns) {
  const value = String(text || '');
  return patterns.some((pattern) => pattern.test(value));
}
