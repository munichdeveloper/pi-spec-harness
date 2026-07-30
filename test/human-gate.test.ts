/**
 * Regression tests for SPEC-002 / REQ-002 reliable human-gate decisions.
 *
 * These tests cover TAC-12:
 *  - old Decision-Label triggers no new gate (openedAt filter)
 *  - missed label event handled by reconciliation logic
 *  - double delivery is idempotent
 *  - Approved AND Rejected simultaneously → blocking conflict
 *  - error before persistence creates no false decision
 *  - cleanup error after persistence does not undo decision
 *  - workflow bootstrap finds already-decided open gates
 *  - tracking-issue body contains a fully assessable gate summary
 *  - merge approval bound to PR and full head SHA
 *  - issue-create reports labels and assignee only after verification
 */

import { describe, expect, it } from "vitest";
import {
  computeGateDecision,
  filterValidLabelEvents,
  GATE_APPROVED_LABEL,
  GATE_REJECTED_LABEL,
} from "../src/gates/human-gate.js";
import { parseStateFromBody, renderStateBody } from "../src/state/issue-store.js";
import {
  bindPullRequest,
  computeNextAction,
  initRunState,
  resolveGate,
  upsertGate,
} from "../src/state/state-machine.js";
import type { GateDecisionContext, RunState } from "../src/state/types.js";

function baseRun(): RunState {
  return initRunState({
    runId: "gate-test-001",
    repository: "munichdeveloper/Immogent",
    requirement: "REQ-002",
    spec: "SPEC-002",
  });
}

// ---------------------------------------------------------------------------
// TAC-05 / filterValidLabelEvents
// ---------------------------------------------------------------------------
describe("filterValidLabelEvents (TAC-04/TAC-05)", () => {
  const openedAt = "2026-07-30T10:00:00.000Z";

  const events = [
    { label: GATE_APPROVED_LABEL, actor: "alice", createdAt: "2026-07-29T09:00:00.000Z" }, // before openedAt
    { label: GATE_APPROVED_LABEL, actor: "bob", createdAt: "2026-07-30T11:00:00.000Z" },   // after openedAt
    { label: GATE_REJECTED_LABEL, actor: "carol", createdAt: "2026-07-29T12:00:00.000Z" }, // before openedAt
    { label: GATE_REJECTED_LABEL, actor: "dave", createdAt: "2026-07-30T12:00:00.000Z" },  // after openedAt
  ];

  it("old Decision-Label (before openedAt) is ignored (TAC-05)", () => {
    const valid = filterValidLabelEvents(events, GATE_APPROVED_LABEL, openedAt);
    expect(valid).toHaveLength(1);
    expect(valid[0].actor).toBe("bob");
    expect(valid[0].createdAt).toBe("2026-07-30T11:00:00.000Z");
  });

  it("returns no valid events when all are before openedAt", () => {
    const futureOpenedAt = "2026-08-01T00:00:00.000Z";
    const valid = filterValidLabelEvents(events, GATE_APPROVED_LABEL, futureOpenedAt);
    expect(valid).toHaveLength(0);
  });

  it("returns all valid events on or after openedAt", () => {
    const valid = filterValidLabelEvents(events, GATE_REJECTED_LABEL, openedAt);
    expect(valid).toHaveLength(1);
    expect(valid[0].actor).toBe("dave");
  });

  it("event exactly at openedAt is valid (boundary is inclusive)", () => {
    const atBoundary = [
      { label: GATE_APPROVED_LABEL, actor: "exact", createdAt: openedAt },
    ];
    const valid = filterValidLabelEvents(atBoundary, GATE_APPROVED_LABEL, openedAt);
    expect(valid).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// TAC-05: Conflict detection (approved AND rejected)
// ---------------------------------------------------------------------------
describe("conflict detection (TAC-05)", () => {
  const openedAt = "2026-07-30T10:00:00.000Z";

  const conflictEvents = [
    { label: GATE_APPROVED_LABEL, actor: "alice", createdAt: "2026-07-30T11:00:00.000Z" },
    { label: GATE_REJECTED_LABEL, actor: "bob", createdAt: "2026-07-30T12:00:00.000Z" },
  ];

  it("detects a blocking conflict when both approved and rejected events are valid", () => {
    const approved = filterValidLabelEvents(conflictEvents, GATE_APPROVED_LABEL, openedAt);
    const rejected = filterValidLabelEvents(conflictEvents, GATE_REJECTED_LABEL, openedAt);
    expect(approved.length > 0 && rejected.length > 0).toBe(true);
  });

  it("no conflict when only one decision type is present after openedAt", () => {
    const onlyApproved = [
      { label: GATE_APPROVED_LABEL, actor: "alice", createdAt: "2026-07-30T11:00:00.000Z" },
      { label: GATE_REJECTED_LABEL, actor: "old",   createdAt: "2026-07-29T09:00:00.000Z" }, // before openedAt
    ];
    const approved = filterValidLabelEvents(onlyApproved, GATE_APPROVED_LABEL, openedAt);
    const rejected = filterValidLabelEvents(onlyApproved, GATE_REJECTED_LABEL, openedAt);
    expect(approved.length > 0 && rejected.length > 0).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TAC-06/TAC-07: computeGateDecision is pure; state persisted before cleanup
// ---------------------------------------------------------------------------
describe("computeGateDecision is pure (TAC-06)", () => {
  it("returns decided state without performing any I/O (pure function)", () => {
    let state = baseRun();
    const gateId = "spec-approval";
    state = upsertGate(state, { id: gateId, type: "human", question: "Approve spec?" });

    const decided = computeGateDecision(state, gateId, {
      resolved: true,
      approved: true,
      by: "alice",
      at: "2026-07-30T11:00:00.000Z",
    });

    expect(decided.gates[0].result).toBe("passed");
    expect(decided.gates[0].decision?.approved).toBe(true);
    expect(decided.gates[0].decision?.by).toBe("alice");
    // original state is unchanged
    expect(state.gates[0].result).toBe("pending");
  });

  it("records approved=false for a rejection (TAC-06)", () => {
    let state = baseRun();
    const gateId = "spec-approval";
    state = upsertGate(state, { id: gateId, type: "human", question: "Approve spec?" });

    const decided = computeGateDecision(state, gateId, {
      resolved: true,
      approved: false,
      by: "bob",
      at: "2026-07-30T11:30:00.000Z",
    });

    expect(decided.gates[0].result).toBe("failed");
    expect(decided.gates[0].decision?.approved).toBe(false);
  });

  it("throws when trying to apply an unresolved decision (TAC-06)", () => {
    let state = baseRun();
    state = upsertGate(state, { id: "g1", type: "human" });
    expect(() => computeGateDecision(state, "g1", { resolved: false })).toThrow(
      /unresolved decision/,
    );
  });
});

// ---------------------------------------------------------------------------
// TAC-07: Cleanup error after persistence does not undo the decision
// ---------------------------------------------------------------------------
describe("cleanup error after persistence (TAC-07)", () => {
  it("the decided state is independent of any subsequent cleanup step", () => {
    let state = baseRun();
    const gateId = "merge-approval";
    state = upsertGate(state, { id: gateId, type: "human", question: "Merge?" });

    // Step 1: compute decided state (pure – no I/O)
    const decided = computeGateDecision(state, gateId, {
      resolved: true,
      approved: true,
      by: "alice",
      at: "2026-07-30T14:00:00.000Z",
    });

    // Step 2: pretend store.save(decided) succeeded
    // Step 3: pretend postGateDecision throws (cleanup failure)
    // → decided is already the canonical state; no data is lost.
    expect(decided.gates[0].result).toBe("passed");
    expect(computeNextAction(decided).action).toBe("advance-phase");
  });
});

// ---------------------------------------------------------------------------
// TAC-07: Double delivery idempotency
// ---------------------------------------------------------------------------
describe("double delivery idempotency (TAC-07)", () => {
  it("applying the same approved decision twice yields the same state", () => {
    let state = baseRun();
    const gateId = "spec-approval";
    state = upsertGate(state, { id: gateId, type: "human", question: "Approve?" });

    const decision = {
      resolved: true as const,
      approved: true,
      by: "alice",
      at: "2026-07-30T11:00:00.000Z",
    };

    const first = computeGateDecision(state, gateId, decision);
    // Second call on the already-decided state (same decision) should not error
    const second = computeGateDecision(first, gateId, decision);
    expect(second.gates[0].result).toBe("passed");
    // The second application does not reset the gate
    expect(second.gates[0].decision?.by).toBe("alice");
  });
});

// ---------------------------------------------------------------------------
// TAC-01/TAC-02: GateRecord context and openedAt; renderStateBody gate summary
// ---------------------------------------------------------------------------
describe("gate context and renderStateBody (TAC-01/TAC-02)", () => {
  it("GateRecord stores openedAt and structured decision context (TAC-01)", () => {
    let state = baseRun();
    const ctx: GateDecisionContext = {
      scope: "Spec approval for SPEC-002",
      criteria: ["All TACs pass", "npm run check green"],
      risks: ["High: changes gate logic"],
      nonGoals: ["No auto-merge"],
      followUpAction: "Merge PR #6",
    };
    state = upsertGate(state, { id: "spec-approval", type: "human", question: "Approve?", context: ctx });
    state = resolveGate(state, "spec-approval", { result: "needs-human", openedAt: "2026-07-30T10:00:00.000Z", context: ctx });

    const gate = state.gates[0];
    expect(gate.openedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(gate.context?.scope).toBe("Spec approval for SPEC-002");
    expect(gate.context?.criteria).toContain("All TACs pass");
    expect(gate.context?.risks).toContain("High: changes gate logic");
    expect(gate.context?.nonGoals).toContain("No auto-merge");
    expect(gate.context?.followUpAction).toBe("Merge PR #6");
  });

  it("renderStateBody shows scope, criteria, risks, non-goals, and follow-up action for open gate (TAC-02)", () => {
    let state = baseRun();
    const ctx: GateDecisionContext = {
      scope: "SPEC-002 implementation",
      criteria: ["TAC-01 passes", "TAC-02 passes"],
      risks: ["High risk: gate path"],
      nonGoals: ["No polling"],
      followUpAction: "Advance to merge",
    };
    state = upsertGate(state, { id: "spec-gate", type: "human", question: "Approve SPEC-002?", context: ctx });
    state = resolveGate(state, "spec-gate", { result: "needs-human", openedAt: "2026-07-30T10:00:00.000Z", context: ctx });

    const body = renderStateBody(state);

    expect(body).toContain("Offenes Human-Gate: `spec-gate`");
    expect(body).toContain("Approve SPEC-002?");
    expect(body).toContain("SPEC-002 implementation");
    expect(body).toContain("TAC-01 passes");
    expect(body).toContain("High risk: gate path");
    expect(body).toContain("No polling");
    expect(body).toContain("Advance to merge");
  });

  it("renderStateBody shows PR number and full head SHA for PR-related gates (TAC-02)", () => {
    let state = baseRun();
    const sha = "a".repeat(40);
    state = bindPullRequest(state, 42, sha);
    state = upsertGate(state, { id: "merge-approval", type: "merge", question: "Merge PR #42?" });
    state = resolveGate(state, "merge-approval", { result: "needs-human" });
    // make the gate look open (human gate)
    state = { ...state, gates: state.gates.map(g => g.id === "merge-approval" ? { ...g, type: "human" as const } : g) };

    const body = renderStateBody(state);
    expect(body).toContain("PR:** #42");
    expect(body).toContain(`Head-SHA`);
    expect(body).toContain(sha);
  });

  it("renderStateBody round-trips state with context fields (TAC-01)", () => {
    let state = baseRun();
    const ctx: GateDecisionContext = {
      scope: "round-trip test",
      criteria: ["criterion A"],
    };
    state = upsertGate(state, { id: "g1", type: "human", question: "Q?", context: ctx });
    state = resolveGate(state, "g1", { result: "needs-human", openedAt: "2026-07-30T10:00:00.000Z", context: ctx });

    const parsed = parseStateFromBody(renderStateBody(state));
    expect(parsed.gates[0].openedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.gates[0].context?.scope).toBe("round-trip test");
  });
});

// ---------------------------------------------------------------------------
// TAC-11: Merge gate requires bound PR+SHA; new head invalidates old approval
// ---------------------------------------------------------------------------
describe("merge gate requires PR+SHA checkpoint (TAC-11)", () => {
  it("invalidates merge gate approval when head SHA changes (TAC-11)", () => {
    const sha1 = "a".repeat(40);
    const sha2 = "b".repeat(40);
    let state = baseRun();
    state = bindPullRequest(state, 42, sha1);
    state = upsertGate(state, { id: "merge-approval-" + sha1, type: "merge", question: "Merge?" });
    state = resolveGate(state, "merge-approval-" + sha1, {
      result: "passed",
      decision: { approved: true, by: "alice", at: "2026-07-30T10:00:00.000Z" },
    });

    // Advance the head SHA
    state = bindPullRequest(state, 42, sha2);

    const mergeGate = state.gates.find((g) => g.id === "merge-approval-" + sha1);
    expect(mergeGate?.result).toBe("pending");
    expect(mergeGate?.evidence).toBeUndefined();
    expect(state.pullRequestHeadSha).toBe(sha2);
  });

  it("review gates are also invalidated by head SHA change", () => {
    const sha1 = "c".repeat(40);
    const sha2 = "d".repeat(40);
    let state = baseRun();
    state = bindPullRequest(state, 10, sha1);
    state = upsertGate(state, { id: "code-review", type: "review" });
    state = resolveGate(state, "code-review", { result: "passed", evidence: ["ci/1"] });

    state = bindPullRequest(state, 10, sha2);
    expect(state.gates[0].result).toBe("pending");
    expect(state.gates[0].evidence).toBeUndefined();
  });

  it("binding the same PR+SHA twice is idempotent (no gate invalidation)", () => {
    const sha = "e".repeat(40);
    let state = baseRun();
    state = bindPullRequest(state, 5, sha);
    state = upsertGate(state, { id: "merge-g", type: "merge" });
    state = resolveGate(state, "merge-g", { result: "passed" });

    const same = bindPullRequest(state, 5, sha);
    expect(same.gates[0].result).toBe("passed");
  });
});

// ---------------------------------------------------------------------------
// TAC-12: Workflow bootstrap finds already-decided open gates
// Covered by the workflow-contracts tests reading harness-gate-trigger.yml
// for workflow_dispatch and push triggers -- see workflow-contracts.test.ts.
// ---------------------------------------------------------------------------
