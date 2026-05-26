import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createProgressEmitter,
  mapStructuredProgressEvent,
} from '../src/research/progress-events.mjs';

describe('progress events', () => {
  it('maps rapid progress profile events to the legacy onProgress shape', () => {
    const progressProfile = {
      generateQuestionsMessage: () => 'Generating rapid follow-up questions',
      searchStartMessage: ({ total }) => `Running ${total} rapid searches`,
      searchItemCompleteMessage: ({ question }) => `Rapid search complete: ${question}`,
      searchItemProgress: ({ completed, total }) => 25 + Math.round((completed / total) * 45),
    };

    assert.deepEqual(
      mapStructuredProgressEvent({ stage: 'generating_questions', progressProfile }),
      { message: 'Generating rapid follow-up questions', progress: 10, level: 'info' },
    );
    assert.deepEqual(
      mapStructuredProgressEvent({ stage: 'searching', total: 3, progressProfile }),
      { message: 'Running 3 rapid searches', progress: 25, level: 'info' },
    );
    assert.deepEqual(
      mapStructuredProgressEvent({
        stage: 'search_item_complete',
        question: 'follow up',
        completed: 2,
        total: 4,
        progressProfile,
      }),
      { message: 'Rapid search complete: follow up', progress: 48, level: 'info' },
    );
  });

  it('maps iterative strategy events through progress profiles', () => {
    const sourceBasedProfile = {
      generateQuestionsMessage: ({ iteration, iterations }) => (
        `Generating research questions for iteration ${iteration}/${iterations}`
      ),
      searchProgressMessage: ({ completed, total, iteration }) => (
        `Completed ${completed}/${total} searches for iteration ${iteration}`
      ),
    };
    const parallelProfile = {
      searchStartMessage: ({ total }) => `Running ${total} parallel searches`,
    };

    assert.deepEqual(
      mapStructuredProgressEvent({
        stage: 'generating_questions',
        iteration: 2,
        iterations: 2,
        progressProfile: sourceBasedProfile,
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
        iteration: 1,
        iterations: 2,
        total: 4,
        progressProfile: parallelProfile,
      }),
      { message: 'Running 4 parallel searches', progress: 15, level: 'info' },
    );
    assert.deepEqual(
      mapStructuredProgressEvent({
        stage: 'search_progress',
        iteration: 1,
        iterations: 2,
        completed: 1,
        total: 2,
        progressProfile: sourceBasedProfile,
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

  it('maps source enrichment and filtering stages', () => {
    const profile = {
      enrichingSourcesMessage: ({ iteration, iterations }) => (
        `Enriching sources for iteration ${iteration}/${iterations}`
      ),
      filteringSourcesMessage: () => 'Filtering sources for relevance',
    };

    assert.deepEqual(
      mapStructuredProgressEvent({
        stage: 'enriching_sources',
        iteration: 1,
        iterations: 2,
        progressProfile: profile,
      }),
      {
        message: 'Enriching sources for iteration 1/2',
        progress: 18,
        level: 'info',
      },
    );
    assert.deepEqual(
      mapStructuredProgressEvent({ stage: 'filtering_sources', progressProfile: profile }),
      {
        message: 'Filtering sources for relevance',
        progress: 75,
        level: 'info',
      },
    );
  });

  it('uses generic fallback messages for strategies without progress profiles', () => {
    assert.deepEqual(
      mapStructuredProgressEvent({
        stage: 'generating_questions',
        iteration: 1,
        iterations: 2,
      }),
      { message: 'Generating research questions', progress: 10, level: 'info' },
    );
    assert.deepEqual(
      mapStructuredProgressEvent({
        stage: 'searching',
        total: 5,
      }),
      { message: 'Running 5 searches', progress: 25, level: 'info' },
    );
  });
});
