import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { inferSearchOutcome } from '../src/research/search-trace.mjs';
import { filterSearchOptions } from '../src/search/search-capabilities.mjs';
import { resolveCompletionStatus } from '../src/research/as-of.mjs';
import { collectSuccessfulPassages } from '../src/research/gap-slot-support.mjs';
import { classifyInvalidReason } from '../src/search/search-provider-error.mjs';
import { resolveEntityAliases } from '../src/research/adaptive/source-policy.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/google-ops-replay.json', import.meta.url), 'utf8'));

describe('google ops replay fixture', () => {
  it('records the pre-fix failure modes without full bodies', () => {
    assert.equal(fixture.desensitized, true);
    assert.ok(!JSON.stringify(fixture).includes('work_dir'));
    assert.equal(fixture.searches[0].outcome, 'rate_limited');
    assert.equal(inferSearchOutcome({
      error: fixture.searches[0].providerError,
    }), 'rate_limited');
    assert.equal(fixture.searches[1].outcome, 'duplicate_query');
  });

  it('shows Google ops cannot honor Planner engines=bing', () => {
    const filtered = filterSearchOptions(
      fixture.searches[0].requestedSearchOptions,
      fixture.provider,
    );
    assert.deepEqual(filtered.effective, {});
    assert.ok(filtered.dropped.includes('engines'));
    assert.equal(fixture.provider.maxQuestionConcurrency, 1);
  });

  it('requires explicit promotion before a competing-slot body can fill commercialization', () => {
    const findings = [{
      gapId: 'gap-competition',
      sources: [{
        id: 'src-36kr',
        url: fixture.searches[2].candidates[0].url,
        content: fixture.searches[2].candidates[0].snippet,
        fetchStatus: 'ok',
      }],
    }];
    assert.equal(collectSuccessfulPassages(findings, {
      gapId: 'gap-commercial',
      allowFallback: false,
    }).length, 0);
    assert.equal(resolveCompletionStatus({
      readiness: { pass: false },
      stopReason: 'safety_cap',
      gaps: [{ id: 'gap-commercial', requiredSlot: true, status: 'body_read' }],
    }), fixture.expectedAfterFix.completionStatusWhenSafetyCap);
  });

  it('treats pre-read entity rejects and transient errors as non-semantic repair', () => {
    assert.equal(classifyInvalidReason('entity_mismatch'), 'relevance_rejected');
    assert.equal(classifyInvalidReason('rate_limited'), 'transient');
    const aliases = resolveEntityAliases(['智谱AI', 'Zhipu AI']);
    assert.ok(aliases.includes('智谱'));
    assert.ok(aliases.includes('Zhipu'));
    assert.ok(!aliases.includes('Open'));
  });
});
