import { normalizeSourceUrl } from '../research/source-candidates.mjs';

export function mergeSearchResults(batches, maxResults) {
  const limit = Number(maxResults);
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Number.POSITIVE_INFINITY;
  const lists = (batches || []).map((batch) => (Array.isArray(batch) ? batch : []));
  const merged = [];
  const seenUrls = new Set();
  const indices = lists.map(() => 0);
  let hasMore = lists.some((batch) => batch.length > 0);

  while (hasMore && merged.length < cap) {
    hasMore = false;
    for (let batchIndex = 0; batchIndex < lists.length; batchIndex += 1) {
      const batch = lists[batchIndex];
      while (indices[batchIndex] < batch.length) {
        const source = batch[indices[batchIndex]];
        indices[batchIndex] += 1;
        if (!isUsableSource(source)) continue;

        const rawUrl = String(source.url || '').trim();
        if (rawUrl) {
          const normalized = normalizeSourceUrl(rawUrl);
          if (normalized && seenUrls.has(normalized)) continue;
          if (normalized) seenUrls.add(normalized);
        }

        merged.push(source);
        if (merged.length >= cap) return merged;
        break;
      }
      if (indices[batchIndex] < batch.length) hasMore = true;
    }
  }

  return merged;
}

function isUsableSource(source) {
  if (!source || typeof source !== 'object') return false;
  return Boolean(
    String(source.url || '').trim()
    || String(source.snippet || '').trim()
    || String(source.content || '').trim()
    || String(source.title || '').trim(),
  );
}
