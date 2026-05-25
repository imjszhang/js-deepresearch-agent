export function mergeSkillResults(batches, maxResults) {
  const merged = [];
  const seenUrls = new Set();
  const indices = batches.map(() => 0);
  let hasMore = batches.some((batch) => batch.length > 0);

  while (hasMore && merged.length < maxResults) {
    hasMore = false;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      while (indices[batchIndex] < batch.length) {
        const source = batch[indices[batchIndex]];
        indices[batchIndex] += 1;

        const url = String(source.url || '').trim();
        if (url && seenUrls.has(url)) {
          continue;
        }
        if (url) {
          seenUrls.add(url);
        }

        merged.push(source);
        if (merged.length >= maxResults) {
          return merged;
        }
        break;
      }

      if (indices[batchIndex] < batch.length) {
        hasMore = true;
      }
    }
  }

  return merged;
}
