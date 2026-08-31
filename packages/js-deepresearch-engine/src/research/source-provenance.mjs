const PROVENANCE_FIELDS = Object.freeze([
  'publisher',
  'author',
  'publishedAt',
  'updatedAt',
  'accessedAt',
  'sourceType',
  'jurisdiction',
  'productVersion',
  'accessStatus',
  'accessNotes',
]);

function present(value) {
  if (value === null || value === undefined) return undefined;
  const normalized = typeof value === 'string' ? value.trim() : value;
  return normalized === '' ? undefined : normalized;
}

export function pickSourceProvenance(...records) {
  const result = {};
  for (const record of records) {
    for (const field of PROVENANCE_FIELDS) {
      if (result[field] !== undefined) continue;
      const value = present(record?.[field]);
      if (value !== undefined) result[field] = value;
    }
  }
  return result;
}

export function withSourceProvenance(source = {}, fetched = {}) {
  return {
    ...source,
    ...pickSourceProvenance(source, fetched),
  };
}

export { PROVENANCE_FIELDS };
