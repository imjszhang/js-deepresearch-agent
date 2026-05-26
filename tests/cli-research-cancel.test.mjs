import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, describe, it } from 'node:test';
import {
  ResearchCancelledError,
  createResearchAbortController,
  runCliResearch,
} from '../src/cli-research-run.mjs';
import { migrateDb, closeDb } from '../src/storage/db.mjs';
import Database from 'better-sqlite3';
import { ResearchRepository } from '../src/storage/research-repository.mjs';
import { SourceRepository } from '../src/storage/source-repository.mjs';

describe('CLI research cancellation', () => {
  afterEach(() => {
    closeDb();
  });
  it('marks history as cancelled when runner aborts', async () => {
    const db = createTestDb();
    const researchRepository = new ResearchRepository(db);
    const sourceRepository = new SourceRepository(db);
    const abortError = new Error('Research aborted');
    abortError.name = 'AbortError';

    await assert.rejects(
      () => runCliResearch({
        query: 'deep research',
        settings: { research: { strategy: 'rapid' } },
        flags: {},
        services: { researchRepository, sourceRepository },
        runner: {
          run: async ({ signal }) => {
            signal?.throwIfAborted?.();
            throw abortError;
          },
        },
        cryptoRandomId: () => 'test-cancel-id',
        signalTarget: new EventEmitter(),
      }),
      ResearchCancelledError,
    );

    const record = researchRepository.get('test-cancel-id');
    assert.equal(record.status, 'cancelled');
    assert.match(record.error, /Research aborted/);
    db.close();
  });

  it('marks history as running before completion', async () => {
    const db = createTestDb();
    const researchRepository = new ResearchRepository(db);
    const sourceRepository = new SourceRepository(db);
    let observedStatus = null;

    await runCliResearch({
      query: 'hello',
      settings: { research: { strategy: 'rapid' } },
      flags: {},
      services: { researchRepository, sourceRepository },
      runner: {
        run: async () => {
          observedStatus = researchRepository.get('test-running-id')?.status;
          return {
            report: '# Report',
            findings: [],
            sources: [{ title: 'A', url: 'https://example.com', snippet: 'A' }],
          };
        },
      },
      cryptoRandomId: () => 'test-running-id',
      signalTarget: new EventEmitter(),
    });

    assert.equal(observedStatus, 'running');
    assert.equal(researchRepository.get('test-running-id').status, 'completed');
    db.close();
  });

  it('aborts on first signal and allows second signal to force exit', () => {
    const signalTarget = new EventEmitter();
    let exitCode = null;
    const originalExit = process.exit;
    process.exit = (code) => {
      exitCode = code;
    };

    try {
      const { controller, install, remove } = createResearchAbortController({ signalTarget });
      install();
      signalTarget.emit('SIGINT');
      assert.equal(controller.signal.aborted, true);
      signalTarget.emit('SIGINT');
      assert.equal(exitCode, 130);
      remove();
    } finally {
      process.exit = originalExit;
    }
  });
});

function createTestDb() {
  const db = new Database(':memory:');
  migrateDb(db);
  return db;
}
