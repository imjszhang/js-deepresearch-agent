import { registerSearchEngine } from 'js-deepresearch-engine';
import { JsEyesCliSearchEngine, normalizeJsEyesSearchConfig } from './js-eyes/public.mjs';

registerSearchEngine('js-eyes', {
  metadata: {
    label: 'JS Eyes',
    requiresBrowser: true,
    supportsServerUrl: true,
    maxQuestionConcurrency: 1,
  },
  create: (config) => new JsEyesCliSearchEngine(normalizeJsEyesSearchConfig(config)),
});
