import crypto from 'node:crypto';

export function sourceKey(source) {
  const url = String(source.url || '').trim();
  return url ? `url:${url}` : `text:${crypto.createHash('sha256')
    .update(JSON.stringify([source.title || '', source.snippet || '']))
    .digest('hex')}`;
}

export function sourceSnapshot(sources = []) {
  const entries = new Map();
  for (const source of sources) entries.set(sourceKey(source), source);
  return [...entries].map(([key, source], position) => ({ key, source, position }));
}
