import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { GAP_SCHEMA_VERSION, RESEARCH_BRIEF_SCHEMA_VERSION } from '../src/index.mjs';

const fixtureDir = path.join(import.meta.dirname, 'fixtures', 'control-plane');

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

describe('Issue #27 control-plane golden fixture', () => {
  it('records current brief/gap schemas and deterministic wave order', () => {
    const brief = readJson('brief.json');
    const gaps = readJson('gaps.json');
    const trace = readJson('trace.json');
    const sources = readJson('sources.json');
    const meta = readJson('meta.json');

    assert.equal(brief.schemaVersion, RESEARCH_BRIEF_SCHEMA_VERSION);
    assert.deepEqual(brief.exclusions, ['forums']);
    assert.deepEqual(brief.consequentialClaims, ['alpha safety']);
    assert.equal(meta.artifactSchemaVersion, 3);

    assert.ok(gaps.every((gap) => gap.schemaVersion === GAP_SCHEMA_VERSION));
    const root = gaps.find((gap) => gap.kind === 'root');
    assert.equal(root.rollup, true);
    assert.ok(gaps.filter((gap) => gap.requiredSlot).every((gap) => gap.status === 'verified'));

    assert.deepEqual(trace.map((entry) => entry.wave || entry.action).filter(Boolean).slice(0, 8), [
      'research_brief',
      'discovery',
      'discovery',
      'readiness_gate',
      'repair',
      'plateau_evaluated',
      'challenge_completed',
      'claim_spot_check',
    ]);
    const challenge = trace.find((entry) => entry.action === 'challenge_completed');
    assert.equal(challenge.queryCount, 1);
    assert.deepEqual(challenge.targetGapIds, ['gap-2']);
    assert.ok(trace.some((entry) => entry.action === 'plateau_evaluated'));
    assert.equal(trace.find((entry) => entry.action === 'focused_stop_decision').reasonCode, 'evidence_sufficient');

    assert.equal(sources[0].publisher, 'Example Docs');
    assert.equal(sources[0].author, null);
    assert.equal(sources[1].publisher, null);
    assert.equal(sources[1].publishedAt, null);
  });
});
