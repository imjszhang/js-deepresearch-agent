import { extractQualityClaims } from 'js-deepresearch-engine';

/**
 * Benchmark compatibility wrapper around the engine's canonical v2 claim extractor.
 * Keeping one implementation prevents runtime and offline metrics from drifting.
 */
export function extractClaims(report = '') {
  return extractQualityClaims(report);
}
