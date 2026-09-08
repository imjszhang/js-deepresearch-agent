# Result delivery, versioned artifacts and control refactor

## Problem and behavior

Previously, repeated resume appended duplicate SQLite sources. Errors after updating history to completed could change the same research to failed; recorder errors in the failure handler could skip history updates entirely. Individual output files were atomic, but a failed overwrite could leave files from different report generations in one session.

The application now commits source snapshots, report, quality and result revision in a shared SQLite transaction. Snapshot synchronization preserves source IDs and order, updates fields and removes missing sources. A repeatable schema migration merges old duplicates, retaining the oldest ID and latest fields, and installs a unique research/source key index. Source identity preserves URL query parameters and uses a tuple hash for sources without URLs.

`completeResearch` separates core commit from publication, recorder, archive, export and notifications. Post-commit errors become safe structured delivery diagnostics. Requested export failures return CLI exit code 1, with usable report/JSON output. Delivery-only resume does not update completion timestamps or rerun successful archives. Error cleanup attempts recorder and history independently and retains the original error.

## Result publication and recovery

Each prepared batch has `results/<resultRevision>/manifest.json` containing hashes of the complete file set, including a final result snapshot. Publication replaces `result-current.json`. Root files are compatibility exports. Benchmark, historical import and Wiki archive paths use versioned artifacts, while legacy sessions retain their previous read path. A corrupt version is an error, not a request to use root mirrors.

With SQLite enabled, the prepared batch is committed to history before filesystem publication. Without history, pointer publication is the durable commit. This is recoverable coordination, not a cross-storage transaction: a crash between these operations can leave history ahead of the directory pointer. Resume reconciles a final checkpoint using the same revision. All versions remain on disk. Versioned intel archives also retain a complete result snapshot, publishing the research run pointer last. Archive inspection, benchmark and Wiki readers use that snapshot, so failed archive retries or append-only legacy collections cannot mix result generations.

The resume planner compares checkpoint sequence numbers. A newest valid `research-complete` snapshot requires no provider calls. Newer steps or `exploratory-continuation-start` prevent an old final report from winning. Starting a continuation records the reset stop counters and extended step cap before external work. Same-session writers hold an exclusive transaction on a separate `.writer.sqlite`; OS lock release handles process death without PID-file cleanup races.

## Control and retrieval

The exploratory coordinator delegates planning helpers, search execution, body reading and finalization to separate modules. Mutable loop stop/counter fields share one explicit `loopLocal` object. The report runner delegates preparation and finalization. Existing evidence, budget, cancellation and checkpoint rules remain covered by the strategy tests.

Wiki retrieval normalizes Unicode/case/whitespace, combines word and Chinese character-pair matching with phrase/title weights, rejects weak isolated matches in long queries and returns snippets near hits. It reads each page once, sorts ties by path and excludes Templates/Lint. This remains lexical retrieval, without a model or semantic index.

## Validation and compatibility

Tests cover snapshot replacement and migration, transaction rollback, post-commit export/recorder/notification errors, error-handler failures, archive callback failures, no-save/no-work-dir boundaries, delivery-only resume, revision reuse, broken compatibility mirrors, batch corruption, stale-final-checkpoint precedence, concurrent writer rejection and lock release after SIGKILL. CLI integration uses a seeded final checkpoint through npm exec and checks valid JSON, nonzero export failure status, completed history and retry deduplication. Wiki tests cover Chinese/mixed queries and late excerpts.

The evidence schema stays at v4; result packaging has its own v1 manifest. Database additions are additive. Existing completed sessions are read without bulk rewriting. When reverting application code, stop active writers first and ensure any required root compatibility exports were successfully written; old code cannot interpret the new publication protocol. New versions and checkpoints are retained for recovery, with no automatic garbage collection.
