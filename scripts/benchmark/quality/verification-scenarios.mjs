// Fixed required cases are reviewed with the contract; never inferred from this run's pass events.
const REQUIRED_TEST_CASES = {
  "V25": [
  {
    "file": "packages/js-deepresearch-engine/tests/sandbox-transport.test.mjs",
    "name": "[V25] sandbox observes real loopback SSE with split UTF-8, CRLF, multiline data and trailing usage"
  },
  {
    "file": "packages/js-deepresearch-engine/tests/sandbox-transport.test.mjs",
    "name": "[V25] sandbox supports Ollama NDJSON including last record without newline"
  },
  {
    "file": "packages/js-deepresearch-engine/tests/sandbox-transport.test.mjs",
    "name": "[V25] sandbox headers timeout makes one request and does not disclose transport errors"
  },
  {
    "file": "packages/js-deepresearch-engine/tests/sandbox-transport.test.mjs",
    "name": "[V25] sandbox heartbeat and role events do not satisfy first effective event timeout"
  },
  {
    "file": "packages/js-deepresearch-engine/tests/sandbox-transport.test.mjs",
    "name": "[V25] sandbox reasoning resets idle timeout without persisting reasoning text"
  },
  {
    "file": "packages/js-deepresearch-engine/tests/sandbox-transport.test.mjs",
    "name": "[V25] sandbox idle timeout fires despite heartbeat traffic after content"
  },
  {
    "file": "packages/js-deepresearch-engine/tests/sandbox-transport.test.mjs",
    "name": "[V25] sandbox total timeout bounds an otherwise progressing stream"
  },
  {
    "file": "packages/js-deepresearch-engine/tests/sandbox-transport.test.mjs",
    "name": "[V25] sandbox timeout is enforced even when an injected fetch ignores abort"
  },
  {
    "file": "packages/js-deepresearch-engine/tests/sandbox-transport.test.mjs",
    "name": "[V25] sandbox complete JSON must be exactly one envelope without prose or duplicate keys"
  },
  {
    "file": "tests/model-sandbox-artifacts.test.mjs",
    "name": "[V25] summary separates warmup, streaming modes and group concurrency while including warmup usage"
  },
  {
    "file": "tests/model-sandbox-artifacts.test.mjs",
    "name": "[V25] confirmed zero, unknown usage and event counts never become fabricated token throughput"
  },
  {
    "file": "tests/model-sandbox-artifacts.test.mjs",
    "name": "[V25] failures, unknown calls and unsent structure cases remain in planned denominators"
  },
  {
    "file": "tests/model-sandbox-artifacts.test.mjs",
    "name": "[V25] provider duration metrics remain separately labeled nanoseconds without inferring environment state"
  },
  {
    "file": "tests/model-sandbox-artifacts.test.mjs",
    "name": "[V25] publish and inspect verify a complete plan-derived manifest including every planned call"
  },
  {
    "file": "tests/model-sandbox-artifacts.test.mjs",
    "name": "[V25] removing manifest call entries cannot conceal omitted, deleted or unlisted outcomes"
  },
  {
    "file": "tests/model-sandbox-artifacts.test.mjs",
    "name": "[V25] summary changes cannot be legitimized just by updating its manifest hash"
  },
  {
    "file": "tests/model-sandbox-artifacts.test.mjs",
    "name": "[V25] publish rejects missing planned outcomes and inspect rejects symbolic-link substitution"
  },
  {
    "file": "tests/model-sandbox-artifacts.test.mjs",
    "name": "[V25] running inspection returns only safe status counters without claiming process liveness"
  },
  {
    "file": "tests/model-sandbox-artifacts.test.mjs",
    "name": "[V25] comparison exposes changed parameters and input hashes instead of ranking different plans"
  },
  {
    "file": "tests/model-sandbox-artifacts.test.mjs",
    "name": "[V25] resource isolation is persisted from the run and cannot be erased in the summary"
  },
  {
    "file": "tests/model-sandbox-artifacts.test.mjs",
    "name": "[V25] complete artifact names support all safe plan identifiers including dots and colons"
  },
  {
    "file": "tests/model-sandbox-cli.test.mjs",
    "name": "[V25] sandbox help and plan avoid research storage and exclude credentials"
  },
  {
    "file": "tests/model-sandbox-cli.test.mjs",
    "name": "[V25] sandbox rejects missing live and unknown flags before dispatch"
  },
  {
    "file": "tests/model-sandbox-cli.test.mjs",
    "name": "[V25] sandbox frozen identity is checked before transport and errors stay safe"
  },
  {
    "file": "tests/model-sandbox-cli.test.mjs",
    "name": "[V25] sandbox live loopback CLI emits one result and inspect compare remain isolated"
  },
  {
    "file": "tests/model-sandbox-cli.test.mjs",
    "name": "[V25] sandbox unknown resource resolution requires explicit server idle confirmation"
  },
  {
    "file": "tests/model-sandbox-lifecycle.test.mjs",
    "name": "[V25] durable call outcome precedes releasing its resource reservation"
  },
  {
    "file": "tests/model-sandbox-lifecycle.test.mjs",
    "name": "[V25] persistence failure drains active workers before closing the resource lock"
  },
  {
    "file": "tests/model-sandbox-lifecycle.test.mjs",
    "name": "[V25] SIGINT cancels the active sandbox request and leaves undispatched cases untouched"
  },
  {
    "file": "tests/model-sandbox-lifecycle.test.mjs",
    "name": "[V25] run duration deadline aborts active work without dispatching remaining cases"
  },
  {
    "file": "tests/model-sandbox-lifecycle.test.mjs",
    "name": "[V25] sandbox events and outcome artifacts allow only safe fields from execution"
  },
  {
    "file": "tests/model-sandbox-lifecycle.test.mjs",
    "name": "[V25] baseline separates buffered and streaming observations without claiming cache or cold start"
  },
  {
    "file": "tests/model-sandbox-runner.test.mjs",
    "name": "[V25] sandbox obeys measured concurrency and never retries structure failures"
  },
  {
    "file": "tests/model-sandbox-runner.test.mjs",
    "name": "[V25] unresolved execution persists across runs and explicit resolution is required"
  },
  {
    "file": "tests/model-sandbox-runner.test.mjs",
    "name": "[V25] complete responses without usage release capacity while keeping usage unknown"
  },
  {
    "file": "tests/model-sandbox-runner.test.mjs",
    "name": "[V25] queued cancellation sends no model request and preserves all planned cases"
  },
  {
    "file": "tests/model-sandbox-runner.test.mjs",
    "name": "[V25] process death releases the OS lock but not unresolved model execution"
  },
  {
    "file": "tests/model-sandbox-runner.test.mjs",
    "name": "[V25] exact and stream replays preserve archived hashes and production claim contracts"
  },
  {
    "file": "tests/model-sandbox-runner.test.mjs",
    "name": "[V25] plan identity and archived changes are rejected before dispatch"
  },
  {
    "file": "tests/model-sandbox-runner.test.mjs",
    "name": "[V25] replay protects source directories and records actual endpoint variants"
  },
  {
    "file": "tests/cli-package.test.mjs",
    "name": "[V25] packaged sandbox CLI loads without development scripts or research storage"
  }
],
  "V24": [
    {
      "file": "packages/js-deepresearch-engine/tests/structured-validation.test.mjs",
      "name": "[V24] claim_validation accepts prose braces and identical fenced answers through production"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/structured-validation.test.mjs",
      "name": "[V24] report accepts prose braces and identical fenced answers through production"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/structured-validation.test.mjs",
      "name": "[V24] narrative_validation accepts prose braces and identical fenced answers through production"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/structured-validation.test.mjs",
      "name": "[V24] exact claim and task IDs remain strict before any text cleanup"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/structured-validation.test.mjs",
      "name": "[V24] bounded retries give safe categories and preserve control flow errors"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/structured-validation.test.mjs",
      "name": "[V24] response recovery preserves truncation and settles known usage once"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/structured-validation.test.mjs",
      "name": "[V24] older parsing protocol revalidates frozen claims and completed revisions stay stable"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/structured-validation.test.mjs",
      "name": "[V24] returned invalid output with unknown usage pauses before retry and keeps its reservation"
    },
    {
      "file": "tests/benchmark-structured-response.test.mjs",
      "name": "[V24] benchmark rejects differences hidden by projection before projection and sends safe retry feedback"
    },
    {
      "file": "tests/benchmark-structured-response.test.mjs",
      "name": "[V24] persisted parse failures stay rejected after restart without redispatch or erased ID diagnostics"
    },
    {
      "file": "tests/benchmark-structured-response.test.mjs",
      "name": "[V24] component-owned retry receives the structural reason without replaying model prose"
    },
    {
      "file": "tests/benchmark-structured-response.test.mjs",
      "name": "[V24] parsing and calibration identities reject old protocol without rewriting history"
    },
    {
      "file": "tests/benchmark-structured-response.test.mjs",
      "name": "[V24] known candidate parsing failure still falls back to complete material after bounded retries"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/structured-response.test.mjs",
      "name": "rejects duplicate keys at every nesting level, including escaped aliases"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/structured-response.test.mjs",
      "name": "does not promote a valid nested answer out of a schema-invalid root"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/structured-response.test.mjs",
      "name": "preserves array order and extra fields when detecting conflicts"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/structured-callers.test.mjs",
      "name": "[V24] Markdown fallback cannot bypass ambiguous JSON with escaped field names"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/structured-callers.test.mjs",
      "name": "[V24] invalid wrapped responses stop before retry or fallback while preserving reservations"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/structured-response.test.mjs",
      "name": "enforces input, scan, nesting and candidate limits before accepting a prefix"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/structured-response.test.mjs",
      "name": "bounds scans of unfinished fence runs and repeated malformed reasoning tags"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/structured-response.test.mjs",
      "name": "does not ignore whole or fenced arrays under the narrative citation policy"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/evidence-store.test.mjs",
      "name": "[V24] inspection parser identity preserves older records without skipping current checks"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/evidence-store.test.mjs",
      "name": "[V24] local gap inspection revisits old parsing results once and freezes the new identity"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/evidence-store.test.mjs",
      "name": "[V24] gap cache identity differs from the frozen pre-parser fingerprint"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/source-enricher-relevance.test.mjs",
      "name": "[V24] assessment unknown usage cannot be converted to failed transport or retried"
    }
  ],
  "V01": [
    {
      "file": "tests/benchmark-verification-contract.test.mjs",
      "name": "[V01] legal false semantic agreement remains attributed through production evaluation, saved output and receipt recovery"
    },
    {
      "file": "tests/benchmark-verification-contract.test.mjs",
      "name": "[V01] response authority cannot construct program or human proof and aggregation preserves fixture dependency"
    }
  ],
  "V02": [
    {
      "file": "tests/benchmark-program-verification.test.mjs",
      "name": "[V02] model scores are absent from program decisions; missing or skipped required checks remain incomplete"
    }
  ],
  "V03": [
    {
      "file": "tests/benchmark-component-review.test.mjs",
      "name": "[V03] a malformed retry cannot resend an accepted sibling or gain a third attempt after restart"
    },
    {
      "file": "tests/benchmark-component-review.test.mjs",
      "name": "[V03] production Judge supplies safe exact-ID feedback and resumes without dispatch: missing"
    },
    {
      "file": "tests/benchmark-component-review.test.mjs",
      "name": "[V03] production Judge supplies safe exact-ID feedback and resumes without dispatch: duplicate"
    },
    {
      "file": "tests/benchmark-component-review.test.mjs",
      "name": "[V03] production Judge supplies safe exact-ID feedback and resumes without dispatch: extra"
    },
    {
      "file": "tests/benchmark-component-review.test.mjs",
      "name": "[V03] production Judge supplies safe exact-ID feedback and resumes without dispatch: unknown"
    },
    {
      "file": "tests/benchmark-component-review.test.mjs",
      "name": "[V03] production Judge supplies safe exact-ID feedback and resumes without dispatch: empty"
    },
    {
      "file": "tests/benchmark-component-review.test.mjs",
      "name": "[V03] production Judge supplies safe exact-ID feedback and resumes without dispatch: non-array"
    }
  ],
  "V04": [
    {
      "file": "tests/benchmark-relation-decision.test.mjs",
      "name": "[V04] repeating a complete empty decision cannot clear a prior omission observation"
    },
    {
      "file": "tests/benchmark-relation-decision.test.mjs",
      "name": "[V04] unchanged normalized evidence cannot obtain a later agreeing audit: identical"
    },
    {
      "file": "tests/benchmark-relation-decision.test.mjs",
      "name": "[V04] unchanged normalized evidence cannot obtain a later agreeing audit: reordered"
    },
    {
      "file": "tests/benchmark-relation-decision.test.mjs",
      "name": "[V04] unchanged normalized evidence cannot obtain a later agreeing audit: unit-alias"
    },
    {
      "file": "tests/benchmark-relation-decision.test.mjs",
      "name": "[V04] unchanged normalized evidence cannot obtain a later agreeing audit: repartitioned"
    }
  ],
  "V05": [
    {
      "file": "tests/benchmark-relation-decision.test.mjs",
      "name": "[V05] changing other evidence cannot erase a retained rejected basis: false"
    },
    {
      "file": "tests/benchmark-relation-decision.test.mjs",
      "name": "[V05] changing other evidence cannot erase a retained rejected basis: true"
    },
    {
      "file": "tests/benchmark-relation-decision.test.mjs",
      "name": "[V05] combining only previously selected ranges preserves each original disagreement: true"
    },
    {
      "file": "tests/benchmark-relation-decision.test.mjs",
      "name": "[V05] combining only previously selected ranges preserves each original disagreement: false"
    }
  ],
  "V06": [
    {
      "file": "tests/benchmark-assertion-bindings.test.mjs",
      "name": "[V06] an empty top-level bindings list remains an exact-ID error, not a legal empty patch"
    },
    {
      "file": "tests/benchmark-assertion-bindings.test.mjs",
      "name": "[V06] legal repair with no new bound positions completes without another audit: empty"
    },
    {
      "file": "tests/benchmark-assertion-bindings.test.mjs",
      "name": "[V06] legal repair with no new bound positions completes without another audit: duplicate"
    },
    {
      "file": "tests/benchmark-assertion-bindings.test.mjs",
      "name": "[V06] legal repair with no new bound positions completes without another audit: subset"
    },
    {
      "file": "tests/benchmark-assertion-bindings.test.mjs",
      "name": "[V06] legal repair with no new bound positions completes without another audit: repartitioned"
    },
    {
      "file": "tests/benchmark-assertion-bindings.test.mjs",
      "name": "[V06] legal repair with no new bound positions completes without another audit: repeated"
    }
  ],
  "V07": [
    {
      "file": "tests/benchmark-assertion-bindings.test.mjs",
      "name": "[V07] a missing cross-paragraph antecedent is repaired by fact ID and reviewed using bound fragments only"
    },
    {
      "file": "tests/benchmark-assertion-bindings.test.mjs",
      "name": "[V07] a table value requires its selected row and column context, not a blanket covered row"
    },
    {
      "file": "tests/benchmark-assertion-bindings.test.mjs",
      "name": "[V07] identical text at another original position is real binding progress"
    }
  ],
  "V08": [
    {
      "file": "tests/benchmark-assertion-bindings.test.mjs",
      "name": "[V08] foreign report IDs and context provenance cannot be reused even for identical text"
    },
    {
      "file": "tests/benchmark-assertion-bindings.test.mjs",
      "name": "[V08] a real locator from an undisplayed distant block cannot be used during initial extraction"
    },
    {
      "file": "tests/benchmark-boundary-diagnostics.test.mjs",
      "name": "[V08] boundary diagnostics preserve explicit statement kinds and expose no oracle fields to the decision"
    }
  ],
  "V09": [
    {
      "file": "tests/benchmark-assertion-bindings.test.mjs",
      "name": "[V09] binding progress counts UTF-16 positions and rejects a split surrogate pair"
    }
  ],
  "V10": [
    {
      "file": "tests/benchmark-verification-contract.test.mjs",
      "name": "[V10] known candidate structure failure falls back to full material while unknown, budget and corrupted material cannot"
    },
    {
      "file": "tests/benchmark-verification-contract.test.mjs",
      "name": "[V10] discarded candidate diagnostics cannot mask a later full material decision pending reason"
    }
  ],
  "V11": [
    {
      "file": "tests/benchmark-verification-contract.test.mjs",
      "name": "[V11] a pending occurrence keeps its denominator while an identical eligible occurrence continues independently"
    },
    {
      "file": "tests/benchmark-verification-contract.test.mjs",
      "name": "[V11] complete raw binding integrity with a pending model assessment skips truth and criteria calls in evaluate"
    },
    {
      "file": "tests/benchmark-verification-contract.test.mjs",
      "name": "[V11] criteria receive the eligible occurrence own quote and context instead of a pending duplicate first occurrence"
    }
  ],
  "V12": [
    {
      "file": "tests/benchmark-program-recovery.test.mjs",
      "name": "[V12] 64 fixed seeds by 40 steps compare recovery and admission with an independent state table"
    }
  ],
  "V13": [
    {
      "file": "tests/benchmark-component-review.test.mjs",
      "name": "[V13] recovering another flight unblocks a previously undispatched budget component without resetting attempts"
    },
    {
      "file": "tests/benchmark-program-recovery.test.mjs",
      "name": "[V13] saved receipt replays through the production Judge with a dispatch-forbidden provider"
    }
  ],
  "V14": [
    {
      "file": "tests/benchmark-verification-contract.test.mjs",
      "name": "[V14] fixed judgment arithmetic follows an independent weighted formula without semantic proof or false observations"
    },
    {
      "file": "tests/benchmark-verification-contract.test.mjs",
      "name": "[V14] an unobserved empty report keeps model thresholds null without creating a provider call"
    }
  ],
  "V15": [
    {
      "file": "tests/benchmark-verification-contract.test.mjs",
      "name": "[V15] deterministic value comparison retains semantic mapping origin, missing success counts and known zero"
    }
  ],
  "V16": [
    {
      "file": "tests/benchmark-artifact-verification.test.mjs",
      "name": "[V16] artifact verification pins a complete revision and only certifies declared references"
    },
    {
      "file": "tests/benchmark-artifact-verification.test.mjs",
      "name": "[V16] valid file hashes cannot hide an unresolved citation or mismatched source owner"
    },
    {
      "file": "tests/benchmark-artifact-verification.test.mjs",
      "name": "[V16] artifact checks retain missing runs and never overwrite inputs through aliases"
    },
    {
      "file": "tests/benchmark-artifact-verification.test.mjs",
      "name": "[V16] artifact CLI executes offline without initializing application settings"
    },
    {
      "file": "tests/benchmark-artifact-verification.test.mjs",
      "name": "[V16] malformed saved ledger types cannot become verified accounting"
    }
  ],
  "V17": [
    {
      "file": "tests/benchmark-program-gates.test.mjs",
      "name": "[V17] complete saved bodies rebuild without baseline model scores using a scripted engine"
    },
    {
      "file": "tests/benchmark-program-gates.test.mjs",
      "name": "[V17] invalid pins, output overlap, forged execution context and missing verification fail before calls"
    }
  ],
  "V18": [
    {
      "file": "tests/benchmark-program-gates.test.mjs",
      "name": "[V18] cached fixture scores and mode drift cannot bypass the live observation gate"
    },
    {
      "file": "tests/benchmark-program-gates.test.mjs",
      "name": "[V18] program gate ignores model quality and cannot be satisfied by optimistic model output"
    },
    {
      "file": "tests/benchmark-program-gates.test.mjs",
      "name": "[V18] explicit modes and schema migration never downgrade old calibration gates"
    }
  ],
  "V19": [
    {
      "file": "tests/benchmark-summary-integrity.test.mjs",
      "name": "[V19] summary requires full artifact integrity even when hashes and accounting are valid"
    },
    {
      "file": "tests/benchmark-summary-integrity.test.mjs",
      "name": "[V19] cached passing scores cannot grant current artifact verification"
    },
    {
      "file": "tests/benchmark-summary-integrity.test.mjs",
      "name": "[V19] summary keeps the pinned revision and never infers verification from a session alone"
    },
    {
      "file": "tests/benchmark-summary-integrity.test.mjs",
      "name": "[V19] every summary CLI agrees with full verification on a hash-valid broken reference"
    },
    {
      "file": "tests/benchmark-program-gates.test.mjs",
      "name": "[V19] matching global model sets do not permit per-case identity swaps"
    },
    {
      "file": "tests/benchmark-program-gates.test.mjs",
      "name": "[V19] new rebuild revisions compare by baseline input and pending samples retain the denominator"
    },
    {
      "file": "tests/benchmark-program-gates.test.mjs",
      "name": "[V19] an observed first repetition cannot hide an unobserved second repetition"
    }
  ],
  "V20": [
    {
      "file": "tests/benchmark-program-verification.test.mjs",
      "name": "[V20] verification bootstrap executes every fixed check before a certificate exists"
    },
    {
      "file": "tests/benchmark-program-verification.test.mjs",
      "name": "[V20] hand-written passes and historical model calibration cannot become program certificates"
    }
  ],
  "V21": [
    {
      "file": "tests/benchmark-program-verification.test.mjs",
      "name": "[V21] registered negative probes stop before transport and owned loopback remains available"
    }
  ],
  "V23": [
    {
      "file": "tests/benchmark-entrypoints.test.mjs",
      "name": "[V23] all former benchmark entrypoints share quality validation and artifact verification without settings"
    },
    {
      "file": "tests/benchmark-entrypoints.test.mjs",
      "name": "[V23] existing-result CLI uses versioned integrity and never reuses stored semantic verdicts"
    },
    {
      "file": "tests/benchmark-entrypoints.test.mjs",
      "name": "[V23] model scoring and strategy dispatch cannot bypass explicit new execution inputs"
    }
  ],
  "V22": [
    {
      "file": "packages/js-deepresearch-engine/tests/atomic-validation.test.mjs",
      "name": "[V22] partial task renders its verified atomic conclusion and keeps the unresolved facet"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/atomic-validation.test.mjs",
      "name": "[V22] new related counter-evidence invalidates cached judgments and cannot coexist with supported"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/evidence-store.test.mjs",
      "name": "[V22] snippets and summaries cannot create body anchors despite successful status"
    },
    {
      "file": "packages/js-deepresearch-engine/tests/research-request.test.mjs",
      "name": "[V22] original request survives normalized brief limits and hostile planner provenance"
    }
  ]
};

// The registry is part of the implementation identity, not inferred from passing tests.
export const VERIFICATION_VERSION = 1;
export const VERIFICATION_SCENARIOS = [
  ['V01', 'assessment provenance'], ['V02', 'independent program result'], ['V03', 'exact ID feedback'],
  ['V04', 'unchanged relation repair'], ['V05', 'partially changed relation repair'], ['V06', 'binding no progress'],
  ['V07', 'binding new positions'], ['V08', 'source isolation'], ['V09', 'UTF-16 boundaries'],
  ['V10', 'candidate fallback'], ['V11', 'pending prerequisites'], ['V12', 'budget admission'],
  ['V13', 'receipt recovery'], ['V14', 'deterministic score arithmetic'], ['V15', 'metric meaning'],
  ['V16', 'artifact publication'], ['V17', 'fixed-body rebuild'], ['V18', 'separate execution gate'],
  ['V19', 'paired comparison'], ['V20', 'verification record and bootstrap'], ['V21', 'network isolation'],
  ['V22', 'research engine contracts'],
  ['V23', 'legacy entrypoint migration'],
  ['V24', 'structured response boundary and recovery'],
  ['V25', 'local model sandbox isolation, transport, lifecycle and artifacts'],
].map(([id, contract]) => ({ id, contract, required: true, titlePrefix: `[${id}]`, tests: REQUIRED_TEST_CASES[id] }));

export function scenarioResults(events) {
  return VERIFICATION_SCENARIOS.map(scenario => {
    const cases = scenario.tests.map(({ file, name }) => {
      const rows = events.filter(e => (e.type === 'test:pass' || e.type === 'test:fail') && e.name === name && e.file === file);
      const status = rows.some(e => e.type === 'test:fail') ? 'failed' : !rows.length || rows.some(e => e.skip || e.todo) ? 'incomplete' : 'passed';
      return { file, name, status };
    });
    return { id: scenario.id, required: cases.length, executed: cases.filter(c => c.status !== 'incomplete').length,
      passed: cases.filter(c => c.status === 'passed').length, cases,
      status: cases.some(c => c.status === 'failed') ? 'failed' : cases.some(c => c.status === 'incomplete') ? 'incomplete' : 'passed' };
  });
}
