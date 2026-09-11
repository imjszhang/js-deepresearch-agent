# Independent research quality benchmark

This suite separates task delivery, research coverage, factual correctness, citation support, conflict handling, and cost. It does not reuse the research runtime's `supported` verdicts as ground truth.

## Inputs

- Four public cases: Redis licensing (7.2.0 / 7.4.0 / 8.0.0, as of 2025-05-31), and SQLite 3.46.0 WAL. Each topic has an explicit and an open prompt.
- Two repetitions per case, deterministic shuffled order, eight planned live Google runs.
- Exploration floor 600000 and cap 1000000 tokens. Total research fuse 1300000 tokens, report output cap 16000 tokens, and wall-clock timeout 120 minutes per run. Internal report/validation usage does not satisfy the exploration floor. Protocol v2 adds the bounded report output required by the existing engine when a total fuse is enabled; v1 shakedown attempts remain separate from the formal baseline.
- Independent evaluator limit 100000 tokens per report. Unknown calls retain reservations. V8 calibration has a shared 600000-token limit, split into boundary diagnostics (60000), development (180000), assertion holdout (150000), and complete-scoring holdout (210000), with no automatic borrowing. These are caps, not usage targets or guarantees of completion.

Gold answers and source bodies live outside the committed suite, under a local directory such as `data/research-eval/v1/`. They must never be supplied as planning context, a local search corpus, or research input. The current suite has no local corpus input. This is interface separation, not an OS security sandbox.

The first gold package contains 20 criteria per topic. Its current review status is **agent_verified**, not human_verified. Source IDs, versions, extraction hashes and the SQLite oracle environment are recorded in `evidence-sources.json`; this file contains no source bodies or answer text. Public websites may subsequently change. An evaluator needs the exact local package with its validated hashes, not newly downloaded pages silently substituted at scoring time.

## Commands

From the repository root:

```bash
npm run benchmark:quality -- validate --suite benchmarks/research-quality/v1/suite.json --gold-dir data/research-eval/v1
npm run verify:programmatic -- --output-dir work_dir/programmatic-verification/my-check
npm run benchmark:quality -- verify-artifacts --campaign work_dir/quality-benchmark/my-baseline/campaign.json --output-dir work_dir/programmatic-verification/my-artifacts
npm run benchmark:quality -- calibration-summary --output-dir work_dir/quality-improvement-round-5/calibration-v8
npm run benchmark:quality -- plan --suite benchmarks/research-quality/v1/suite.json --output-dir work_dir/quality-benchmark/my-baseline --search-cli /absolute/path/to/js-eyes --skill-dir /absolute/path/to/js-google-ops-skill
npm run benchmark:quality -- run --campaign work_dir/quality-benchmark/my-baseline/campaign.json --program-verification work_dir/programmatic-verification/my-check/program-verification.json
npm run benchmark:quality -- score --mode model-observation --program-verification work_dir/programmatic-verification/my-check/program-verification.json --campaign work_dir/quality-benchmark/my-baseline/campaign.json --gold-dir data/research-eval/v1
npm run benchmark:quality -- score --mode model-observation --program-verification work_dir/programmatic-verification/my-check/program-verification.json --campaign work_dir/quality-benchmark/my-baseline/campaign.json --gold-dir data/research-eval/v1 --diagnose
npm run benchmark:quality -- summary --campaign work_dir/quality-benchmark/my-baseline/campaign.json
npm run benchmark:quality -- compare --baseline work_dir/quality-benchmark/my-baseline/campaign.json --candidate work_dir/quality-benchmark/my-candidate/campaign.json
```

`plan`, `validate`, `calibration-validate`, `calibration-budget` and `calibration-summary` do not call search or LLM. `calibrate` can make model calls; it freezes the code, actual model parameters, all input/oracle hashes, stage budgets and stage order before dispatch. The round is bound to one output directory through a shared local registry. Repeating the command resumes the same round; changing directories cannot reset its budget. V5 and V6 did not pass development. V7 retains program-generated locators and separately defined execution metrics, adds independent semantic relation review, and caches truth and each citation separately. Source bodies are deduplicated in requests while source identities remain separate. Legacy `score --calibration` remains blocked until a compatible complete calibration passes; the explicit model-observation commands above use program verification instead. V8 suites remain historical and are rejected by v9 code. Continuing an old frozen run requires its original code environment. Do not relabel the failed round or rerun it with retuned inputs.

`run` invokes `npm exec --package=. -- jdr research` with argument arrays and the original query. It uses `--no-save`; current CLI completion therefore does not add application history or archive research to intel. Settings are read but never changed with `config set`.

`score` loads a pinned manifest/revision, including validated evidence bodies and citation registry. It does not change the research result or follow a later `result-current` pointer. Existing score files must match their original gold hash and judge identity. Raw reports, evidence, judge answers and budget ledgers remain in ignored local directories.

## Gold package contract

Each `<topicId>.json` has `schemaVersion`, `rubricVersion`, `topicId`, `reviewStatus`, `sources` and `criteria`.

Each source has an ID, URL, version, relative `bodyFile`, SHA-256 `bodyHash` and extraction version. Each criterion has an ID, expected answer, scope, decisive qualifiers, predefined partial-credit policy, core/critical flags, weight (1 or 2), common errors, optional conflict case, requirement IDs, anchors and a review record. An anchor identifies a source plus a UTF-16 `[start,end)` span and its text hash.

Build/review the package before inspecting tested reports. Changed truth or scoring policy requires a new rubric version and rescoring all related outputs. Equivalent reliable evidence is allowed; URL equality is not the truth test. Critical historical claims should be checked against release tags or source archives, not merely a current homepage.

## SQLite oracle

Download the official SQLite 3.46.0 amalgamation to an ignored local directory. Verify its SHA-256 against `evidence-sources.json`. Compile `scripts/benchmark/quality/oracles/sqlite/oracle.c` against that amalgamation's `sqlite3.c` and header, without `NDEBUG`. Run the executable with an empty temporary directory argument, then remove that directory.

The program asserts the exact SQLite version and tests independent-process writer contention, stale-snapshot write upgrade, a reader preventing checkpoint progress, and a main-file-only copy missing committed WAL data while the backup API preserves it. It prints source ID, compile options, PRAGMAs, return codes and measured row counts. Tests use explicit transaction ordering and child-process completion, not sleep-based timing. These are evaluator experiments; they do not mean the research agent performed experiments itself.

## Scoring and review

All main-report factual assertions are extracted, including uncited statements, summaries and table cells. The evidence appendix is diagnostic context, not delivered coverage. Each frozen criterion and extracted fact receives exactly one independent judgment. Duplicate, extra, missing or unanchored judgments fail explicitly.

Coverage uses all predetermined criteria as denominator. An empty report scores zero coverage; undefined accuracy ratios are N/A. The independent fact verdict limits any optimistic criterion match. Citation existence or topical similarity never proves semantic support. Facts without sufficient verification remain visible in the denominator. Repeated expressions cannot add criterion points.

New model output has `machine_draft` or `pending_review` workflow status and explicit `origin: model_assessment` (or `scripted_fixture` in offline tests). `modelThresholdsMet` describes the numerical thresholds conditional on those judgments; it is null when assessment is incomplete. There is no new top-level `qualityTargetMet`. `bindingIntegrity` verifies declared text locations; `bindingAssessment` records model fidelity judgments. Neither exact quotes nor repeated model agreement proves semantic truth. `programVerification` and `artifactVerification` are separate code-owned results, and human review requires an actual review record. Review all major errors, conflicts, failed and pending items, plus at least 20% of accepted facts. Review extraction blocks as well: an omitted fact can otherwise escape a downstream judge. Keep reviewer identity, judgment changes and evidence links in the local review record; never claim human review for an agent-only review.

The calibration set is synthetic and agent-labeled. V8 requires all 24 explicit boundary diagnostics and all 20 fixed development cases to match before executing the 20 assertion holdouts and 14 complete-scoring reports (seven control pairs). The 34 holdouts retain their original text and oracle and were not called by V5/V6. Boundary diagnostics are exposed examples and are not included in the 54-case calibration denominator. Qualification requires at least 18/20 assertion cases, complete assertion coverage without unexpected pending items or critical false acceptance, and 14/14 scoring cases plus all control relations. Each assertion's position, type, truth and citations are checked against a frozen private oracle. Only production rubric/evidence inputs reach the evaluated model. These thresholds do not imply statistical reliability across domains or human blind review.

## Failures and recovery

- Research failures remain among the eight planned runs. Delivery success uses all planned runs; conditional content scores never replace it.
- Preflight failure before a session pauses the batch. Diagnose the environment before retrying. Artifact corruption also pauses dispatch.
- `run --resume-run <id>` resumes an interrupted recoverable session as another attempt of the same run. It does not add a repetition or automatically continue an already closed exploration loop.
- A surviving campaign `.lock` must be inspected for a live owner before removal. Never remove a live writer's lock.
- Unknown judge calls are not silently retried. Saved responses are reparsed/reused without another external call, and settled usage is counted once. Invalid response structure has a bounded retry.
- Each extraction/audit/repair/relation/matching stage permits at most two dispatches per item. Targeted semantic extraction repair occurs at most once; a final audit either accepts coverage or preserves pending status. An unresolved response/usage blocks new calls. Calibration and score directories use OS-backed single-writer locks.
- Per-run stdout/stderr and structured evaluation failures stay local. A budget/structure/provider failure produces an unevaluated/pending result, not zero cost or a passing score.
- `evaluation-state.json` identifies the current evaluation phase independently from research state. Historical failures remain in `evaluation-failures/`; a last-failure file is not evidence that a later score failed. Calibration caches require the same fixture and judge identity/version.
- `floorStatus`, research completion, evaluator completion and content quality are separate. Safe early stops are not padded to reach the requested floor.

## Comparisons and limitations

Comparisons check suite, protocol, settings, search skill, lockfile, gold and judge versions. Show every repetition, group means/ranges, criterion changes, failures and cost uncertainty. Two repetitions reveal instability but do not establish significance. Live Google is not deterministic, even with frozen gold.

`--diagnose` performs bounded review of candidate saved body contexts, claims and bindings. Candidate ranking is not a truth judgment. If the available trace cannot establish the stage, use `unattributable`; no matched passage is not evidence of web-wide absence. A hash-checked checkpoint timeline records first-observed candidates, body versions, passages, claim records and bindings up to the pinned result revision. These are checkpoint boundaries, not exact action times. Historical correctness is not inferred from stored verdicts: its first timestamp stays unmeasured. Evidence accumulation is not an intermediate report-quality curve.

The first live campaign uses `zh-CN` and the existing Google/browser region defaults; an explicit region was not passed by the current research CLI. Browser personalization and region are observational limitations, not fully controlled variables.

The former `benchmark`, `benchmark:strategies` and `benchmark:extract` entry points forward quality subcommands to this same implementation. Their existing-result modes now perform offline artifact verification without stored/keyword semantic scoring. Legacy bundles lacking versioned evidence remain incomplete. Single-call `replay` remains unchanged. Artifact rescoring and fixed component fixtures are distinct from live end-to-end research. Arbitrary new planner queries cannot be reproduced by single-call replay.

V8 preflight JSON must contain the current `codeIdentity` (`evaluatorCodeIdentity()`), `verificationIdentity` (`verificationIdentity()`), and `checks.test/lint/build/diffCheck.passed=true` backed by completed checks. The freeze stores the plan hash, this validation record, source/test file hashes, locator and metric versions, and the prior exposure registry hash. Changing verified code or fixtures invalidates the certificate. Raw receipts and normalized accepted candidates remain separate. One component has at most two dispatches per stage; completed truth and citation components survive failures in their siblings; ambiguity shares that budget, and semantic omission repair runs at most once. Missing successful-body-read counts are unverifiable, never inferred from source-read budget counts.

V6 actual-model acceptance: 10/20 development cases processed, 4 complete matches; stage reservation budget stopped further calls at 51,950 confirmed tokens. Both holdouts remain unexecuted. Formal qualification is blocked. See [round 3 results](../../../journal/2026-09-11/calibration-round-3-results.md).

V7 requires a separately validated relation before any selected quote can establish support or contradiction. Missing measurements, version differences and absence of a guarantee do not automatically establish a false property. Every applicable source must have a completed check; an empty completed check means no verification in that supplied scope. Semantic disagreement stays pending without changing the original verdict. `calibration-budget` lists known extraction reservations and marks later model-dependent usage as unknown; per-call reservations remain conservative.

V7 actual-model acceptance: all 20 development cases processed, 15 complete matches; boundary diagnostics 12/14. Four development facts/citations remain pending after semantic disagreement; one report loses a required cross-sentence context anchor. The run used 96,728 confirmed tokens in 81 calls, with no unknown usage. Same-directory resume added zero calls/tokens and preserved 182 artifact files. Both holdouts remain unexecuted; formal qualification remains blocked. See [round 4 results](../../../journal/2026-09-11/calibration-round-4-results.md).

V8 separates candidate discovery, full-material evidence decisions and basis/omission review. Every material is reviewed even when candidates or relations are empty. A definite invalid basis or omission permits one semantic repair, followed by final review; uncertainty remains pending. Each physical binding audit sees only one report occurrence and its bound fragments. Missing context permits one repair against report locators, with cache invalidation for the changed binding. Extraction requires both coverage and binding completeness. Assertion holdout failure now blocks the scoring holdout. The 24 known diagnostics include relation invariance under presentation changes; they do not claim actual-model end-to-end extraction coverage.

V8 actual-model acceptance did not pass: 20/24 boundary diagnostics; 18/20 development cases processed, with 16 complete matches, two pending and two unexecuted. Development paused at 175,583 confirmed tokens because its remaining stage budget could not reserve the next request. Total usage was 208,834 tokens across 135 calls, with no unknown usage. Four boundary errors were incorrectly confirmed, and one binding repair twice returned an empty ID set. Same-directory resume added zero calls/tokens and preserved 272 artifact files. All 34 holdouts remain unexecuted, and formal scoring/rebuild/live qualification stays blocked. Local tests passed 1,155/1,155. See [round 5 results](../../../journal/2026-09-11/calibration-round-5-results.md).

## Program verification (current engineering acceptance)

`verify-program` executes the existing full test suite, 23 registered contract scenario groups (including compatibility entrypoint migration), 64 fixed fault-sequence seeds (up to 40 operations each), lint, build and whitespace checks. It needs no previous certificate, model credentials, private reports or real search. Its record binds code, dependencies, tests, scenario identities and executed result/log hashes. Missing/skipped checks or unavailable isolation produce `incomplete`; failures produce `failed`. Only complete success produces `passed`. Re-running requires a new output directory. Local hashes establish identity and consistency, not authentication against a malicious local editor.

macOS runs in an OS sandbox; Linux CI enters a network namespace with loopback only. Tools inherit network guards and may use only registered test listeners. Actual external dispatches and unexpected attempts must be zero. Predeclared interception probes are counted separately and must be rejected before transport. Dependency installation happens before isolation. The SQLite domain oracle above is a separate optional experiment and is not silently downloaded or counted in program verification.

The new benchmark execution gate checks program verification and pinned inputs/budgets. It does not demand model calibration accuracy or a 10pp coverage improvement. Eligible never starts an experiment. `rebuild --program-verification <record> --campaign <baseline> --output-dir <new-directory>` retains the four fixed first-repeat cases, locks, cumulative budgets, body-only input and output isolation without requiring baseline model scoring to finish. Real run/score/rebuild calls remain explicit commands. Ordinary `jdr research` and the API do not require this record.

Optional gate files use `{ "schemaVersion": 2, "kind": "benchmark_program_execution", "operation": "run", "programVerification": "relative/program-verification.json", "campaign": "relative/campaign.json" }` and the `program-execution-gate --gate-config <file>` command. Existing `validationGate` files and `--calibration` retain their old behavior; mixing old/new modes is rejected. A regenerated verification timestamp never changes an identical model request cache identity.

Comparison pairs each case/repeat and checks its own report pin, rubric, judge and origin. A rebuilt output gets a new revision and records the old baseline as its input pin. Pending and unobserved rows remain in the planned denominator; paired model means do not mix unpaired completions. Scripted records cannot be relabeled as live observations or update live exposure history.

The v5–v8 results above remain failed historical model observations. Program acceptance does not change those results or claim their semantic problems have been solved.
