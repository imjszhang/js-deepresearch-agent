# Independent research quality benchmark

This suite separates task delivery, research coverage, factual correctness, citation support, conflict handling, and cost. It does not reuse the research runtime's `supported` verdicts as ground truth.

## Inputs

- Four public cases: Redis licensing (7.2.0 / 7.4.0 / 8.0.0, as of 2025-05-31), and SQLite 3.46.0 WAL. Each topic has an explicit and an open prompt.
- Two repetitions per case, deterministic shuffled order, eight planned live Google runs.
- Exploration floor 600000 and cap 1000000 tokens. Total research fuse 1300000 tokens, report output cap 16000 tokens, and wall-clock timeout 120 minutes per run. Internal report/validation usage does not satisfy the exploration floor. Protocol v2 adds the bounded report output required by the existing engine when a total fuse is enabled; v1 shakedown attempts remain separate from the formal baseline.
- Independent evaluator limit 100000 tokens per report. Unknown calls retain reservations. Calibration has its own 250000-token limit.

Gold answers and source bodies live outside the committed suite, under a local directory such as `data/research-eval/v1/`. They must never be supplied as planning context, a local search corpus, or research input. The current suite has no local corpus input. This is interface separation, not an OS security sandbox.

The first gold package contains 20 criteria per topic. Its current review status is **agent_verified**, not human_verified. Source IDs, versions, extraction hashes and the SQLite oracle environment are recorded in `evidence-sources.json`; this file contains no source bodies or answer text. Public websites may subsequently change. An evaluator needs the exact local package with its validated hashes, not newly downloaded pages silently substituted at scoring time.

## Commands

From the repository root:

```bash
npm run benchmark:quality -- validate --suite benchmarks/research-quality/v1/suite.json --gold-dir data/research-eval/v1
npm run benchmark:quality -- calibrate --output-dir data/research-eval/calibration-v2
npm run benchmark:quality -- plan --suite benchmarks/research-quality/v1/suite.json --output-dir work_dir/quality-benchmark/my-baseline --search-cli /absolute/path/to/js-eyes --skill-dir /absolute/path/to/js-google-ops-skill
npm run benchmark:quality -- run --campaign work_dir/quality-benchmark/my-baseline/campaign.json
npm run benchmark:quality -- score --campaign work_dir/quality-benchmark/my-baseline/campaign.json --gold-dir data/research-eval/v1 --calibration data/research-eval/calibration-v2/calibration.json
npm run benchmark:quality -- score --campaign work_dir/quality-benchmark/my-baseline/campaign.json --gold-dir data/research-eval/v1 --calibration data/research-eval/calibration-v2/calibration.json --diagnose
npm run benchmark:quality -- summary --campaign work_dir/quality-benchmark/my-baseline/campaign.json
npm run benchmark:quality -- compare --baseline work_dir/quality-benchmark/my-baseline/campaign.json --candidate work_dir/quality-benchmark/my-candidate/campaign.json
```

`plan` and `validate` do not call search or LLM. `run` invokes `npm exec --package=. -- jdr research` with argument arrays and the original query. It uses `--no-save`; current CLI completion therefore does not add application history or archive research to intel. Settings are read but never changed with `config set`.

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

Machine output has `machine_draft` or `pending_review` status. `machineThresholdsMet` records the numeric thresholds; the CLI sets `qualityTargetMet` only when the supplied matching calibration also passed. An absent or failed calibration keeps qualification false and review pending. This is not human certification. Review all major errors, conflicts, failed and pending items, plus at least 20% of accepted facts. Review extraction blocks as well: an omitted fact can otherwise escape a downstream judge. Keep reviewer identity, judgment changes and evidence links in the local review record; never claim human review for an agent-only review.

The calibration set is synthetic and agent-labeled, with an independently designated holdout subset. Report a confusion matrix, critical false acceptances and missing fact extractions, not just total agreement. The initial 90% target does not imply statistical reliability across domains.

## Failures and recovery

- Research failures remain among the eight planned runs. Delivery success uses all planned runs; conditional content scores never replace it.
- Preflight failure before a session pauses the batch. Diagnose the environment before retrying. Artifact corruption also pauses dispatch.
- `run --resume-run <id>` resumes an interrupted recoverable session as another attempt of the same run. It does not add a repetition or automatically continue an already closed exploration loop.
- A surviving campaign `.lock` must be inspected for a live owner before removal. Never remove a live writer's lock.
- Unknown judge calls are not silently retried. Saved responses are reparsed/reused without another external call, and settled usage is counted once. Invalid response structure has a bounded retry.
- Per-run stdout/stderr and structured evaluation failures stay local. A budget/structure/provider failure produces an unevaluated/pending result, not zero cost or a passing score.
- `evaluation-state.json` identifies the current evaluation phase independently from research state. Historical failures remain in `evaluation-failures/`; a last-failure file is not evidence that a later score failed. Calibration caches require the same fixture and judge identity/version.
- `floorStatus`, research completion, evaluator completion and content quality are separate. Safe early stops are not padded to reach the requested floor.

## Comparisons and limitations

Comparisons check suite, protocol, settings, search skill, lockfile, gold and judge versions. Show every repetition, group means/ranges, criterion changes, failures and cost uncertainty. Two repetitions reveal instability but do not establish significance. Live Google is not deterministic, even with frozen gold.

`--diagnose` performs bounded review of candidate saved body contexts, claims and bindings. Candidate ranking is not a truth judgment. If the available trace cannot establish the stage, use `unattributable`; no matched passage is not evidence of web-wide absence. A hash-checked checkpoint timeline records first-observed candidates, body versions, passages, claim records and bindings up to the pinned result revision. These are checkpoint boundaries, not exact action times. Historical correctness is not inferred from stored verdicts: its first timestamp stays unmeasured. Evidence accumulation is not an intermediate report-quality curve.

The first live campaign uses `zh-CN` and the existing Google/browser region defaults; an explicit region was not passed by the current research CLI. Browser personalization and region are observational limitations, not fully controlled variables.

Existing `benchmark`, `benchmark:strategies` and single-call `replay` remain unchanged. Artifact rescoring and fixed component fixtures are distinct from live end-to-end research. Arbitrary new planner queries cannot be reproduced by single-call replay.
