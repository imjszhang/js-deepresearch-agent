import assert from 'node:assert/strict';

// Fixtures specify a fixed response sequence. They may inspect request shape but
// never synthesize a success judgment from the production program's output.
export class ScriptedProvider {
  constructor(steps) { this.steps = steps; this.calls = []; this.origin = 'scripted_fixture'; }
  async completeWithMetadata(request) {
    const step = this.steps[this.calls.length];
    assert.ok(step, 'Unexpected scripted provider dispatch');
    const input = JSON.parse(request.messages[1].content);
    if (step.instructions) assert.ok(request.messages[0].content.endsWith(step.instructions));
    if (step.ids) assert.deepEqual(input[step.field].map(item => item.id), step.ids);
    if (step.attempt != null) assert.ok(input.reviewAttempt.every(item => item.attempt === step.attempt));
    step.inspect?.(input, request);
    this.calls.push({ purpose: step.purpose, attempt: step.attempt, itemCount: step.ids?.length || 0 });
    if (step.error) throw Object.assign(new Error(step.error), { code: step.error });
    return { text: JSON.stringify(step.response), usage: { totalTokens: step.tokens ?? 3 }, origin: 'scripted_fixture' };
  }
  assertConsumed() { assert.equal(this.calls.length, this.steps.length, 'Missing scripted provider dispatch'); }
}
