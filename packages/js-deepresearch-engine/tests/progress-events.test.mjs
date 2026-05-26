import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createProgressEmitter,
  mapStructuredProgressEvent,
} from '../src/research/progress-events.mjs';

describe('progress events', () => {
  it('maps rapid strategy events to the legacy onProgress shape', () => {
    assert.deepEqual(
      mapStructuredProgressEvent({ stage: 'generating_questions', strategy: 'rapid' }),
      { message: 'Generating rapid follow-up questions', progress: 10, level: 'info' },
    );
    assert.deepEqual(
      mapStructuredProgressEvent({ stage: 'searching', strategy: 'rapid', total: 3 }),
      { message: 'Running 3 rapid searches', progress: 25, level: 'info' },
    );
    assert.deepEqual(
      mapStructuredProgressEvent({
        stage: 'search_item_complete',
        strategy: 'rapid',
        question: 'follow up',
        completed: 2,
        total: 4,
      }),
      { message: 'Rapid search complete: follow up', progress: 48, level: 'info' },
    );
  });

  it('maps iterative strategy events for source-based and parallel variants', () => {
    assert.deepEqual(
      mapStructuredProgressEvent({
        stage: 'generating_questions',
        strategy: 'source-based',
        iteration: 2,
        iterations: 2,
      }),
      {
        message: 'Generating research questions for iteration 2/2',
        progress: 40,
        level: 'info',
      },
    );
    assert.deepEqual(
      mapStructuredProgressEvent({
        stage: 'searching',
        strategy: 'parallel',
        iteration: 1,
        iterations: 2,
        total: 4,
      }),
      { message: 'Running 4 parallel searches', progress: 15, level: 'info' },
    );
    assert.deepEqual(
      mapStructuredProgressEvent({
        stage: 'search_progress',
        strategy: 'source-based',
        iteration: 1,
        iterations: 2,
        completed: 1,
        total: 2,
      }),
      {
        message: 'Completed 1/2 searches for iteration 1',
        progress: 28,
        level: 'info',
      },
    );
  });

  it('passes through legacy string emit calls unchanged', () => {
    const events = [];
    const emit = createProgressEmitter((event) => events.push(event));

    emit('Echo strategy running', 50);
    emit({ stage: 'research_complete' });

    assert.deepEqual(events, [
      { message: 'Echo strategy running', progress: 50, level: 'info' },
      { message: 'Research complete', progress: 100, level: 'info' },
    ]);
  });
});
