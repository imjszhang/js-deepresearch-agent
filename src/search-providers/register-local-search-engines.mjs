import { registerSearchEngine, registerContentFetchHandler } from 'js-deepresearch-engine';
import { JsEyesCliSearchEngine, normalizeJsEyesSearchConfig } from './js-eyes/public.mjs';
import { createZhihuContentFetchHandler } from './js-eyes/zhihu-content-fetcher.mjs';
import {
  LocalDirectorySearchEngine,
  createLocalFileContentFetchHandler,
  normalizeLocalSearchConfig,
} from './local/public.mjs';

registerSearchEngine('js-eyes', {
  metadata: {
    label: 'JS Eyes',
    requiresBrowser: true,
    supportsServerUrl: true,
    maxQuestionConcurrency: 1,
  },
  create: (config) => new JsEyesCliSearchEngine(normalizeJsEyesSearchConfig(config)),
});

registerSearchEngine('local', {
  metadata: {
    label: 'Local directories',
    requiresBrowser: false,
    supportsCorpusDirs: true,
  },
  create: (config) => new LocalDirectorySearchEngine(normalizeLocalSearchConfig(config)),
});

registerContentFetchHandler(createZhihuContentFetchHandler());
registerContentFetchHandler(createLocalFileContentFetchHandler());
