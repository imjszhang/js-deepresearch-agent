export const DEFAULT_LOCAL_IGNORE = Object.freeze(['.git', 'node_modules', '.DS_Store']);

export const DEFAULT_LOCAL_EXTENSIONS = Object.freeze([
  'md',
  'txt',
  'markdown',
  'pdf',
  'docx',
  'doc',
  'rtf',
  'pptx',
]);

export const TEXT_SEARCH_EXTENSIONS = Object.freeze(['md', 'txt', 'markdown']);

export const LOCAL_SEARCH_PREVIEW_CHARS = 8000;
export const LOCAL_SEARCH_SNIPPET_CHARS = 240;

export const LOCAL_SEARCH_DEFAULTS = Object.freeze({
  dirs: [],
  ignore: DEFAULT_LOCAL_IGNORE,
  extensions: DEFAULT_LOCAL_EXTENSIONS,
});
