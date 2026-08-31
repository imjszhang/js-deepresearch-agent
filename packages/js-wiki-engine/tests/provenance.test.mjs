import assert from 'node:assert/strict';
import { it } from 'node:test';
import { normalizeWikiSource } from '../src/schema.mjs';

it('preserves observed provenance without fabricating missing fields', () => {
  const source = normalizeWikiSource({
    title: 'Release note',
    url: 'https://example.com/release',
    publisher: 'Example Foundation',
    author: 'A. Maintainer',
    publishedAt: '2026-08-01',
    updatedAt: '2026-08-02',
    accessedAt: '2026-08-31T12:00:00.000Z',
    sourceType: 'official_documentation',
    jurisdiction: 'US',
    productVersion: '4.2',
    accessStatus: 'ok',
    accessNotes: 'Public HTML',
  });
  assert.equal(source.publisher, 'Example Foundation');
  assert.equal(source.productVersion, '4.2');
  assert.equal(source.accessStatus, 'ok');
  const missing = normalizeWikiSource({ title: 'Unknown source' });
  assert.equal(missing.publisher, null);
  assert.equal(missing.accessedAt, null);
});
