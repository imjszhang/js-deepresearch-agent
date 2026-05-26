import { registerSearchEngine, registerContentFetchHandler } from 'js-deepresearch-engine';
import { JsEyesCliSearchEngine, normalizeJsEyesSearchConfig } from './js-eyes/public.mjs';
import { createZhihuContentFetchHandler } from './js-eyes/zhihu-content-fetcher.mjs';

registerSearchEngine('js-eyes', {
  metadata: {
    label: 'JS Eyes',
    requiresBrowser: true,
    supportsServerUrl: true,
    maxQuestionConcurrency: 1,
  },
  create: (config) => new JsEyesCliSearchEngine(normalizeJsEyesSearchConfig(config)),
});

registerContentFetchHandler(createZhihuContentFetchHandler());
