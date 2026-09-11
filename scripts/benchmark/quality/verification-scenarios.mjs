// Fixed required cases are reviewed with the contract; never inferred from this run's pass events.
const REQUIRED_TEST_CASES = {
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
