import { describe, expect, it } from "vitest";
import {
  acknowledgeRejectedGate,
  bindDeliveryPullRequest,
  bindImplementationPullRequest,
  bindPullRequest,
  classifyDeliveryPrMergeEffect,
  computeNextAction,
  finishIteration,
  hasOpenHumanGate,
  recordDeliveryMergeEffect,
  initRunState,
  reconcileInit,
  resolveGate,
  startIteration,
  transitionPhase,
  upsertGate,
} from "../src/state/state-machine.js";

function baseRun() {
  return initRunState({
    runId: "test-run-001",
    repository: "munichdeveloper/Immogent",
    requirement: "REQ-001",
    spec: "SPEC-011",
  });
}

describe("state-machine", () => {
  it("initializes a run in phase 'requirement' with no gates", () => {
    const state = baseRun();
    expect(state.phase).toBe("requirement");
    expect(state.gates).toHaveLength(0);
    expect(computeNextAction(state).action).toBe("advance-phase");
  });

  it("reconcileInit is idempotent for matching immutable fields", () => {
    const state = baseRun();
    const again = reconcileInit(state, {
      runId: state.runId,
      repository: state.repository,
      requirement: state.requirement,
      spec: state.spec,
    });
    expect(again).toBe(state);
  });

  it("reconcileInit throws on conflicting immutable fields", () => {
    const state = baseRun();
    expect(() =>
      reconcileInit(state, {
        runId: state.runId,
        repository: state.repository,
        requirement: state.requirement,
        spec: "SPEC-999",
      }),
    ).toThrow(/spec/);
  });

  it("an open human gate blocks computeNextAction regardless of phase", () => {
    let state = baseRun();
    state = upsertGate(state, { id: "spec-approval", type: "human", question: "Approve SPEC-011?" });
    expect(hasOpenHumanGate(state)?.id).toBe("spec-approval");
    expect(computeNextAction(state).action).toBe("await-human-gate");
  });

  it("resolving a human gate with passed+approved clears the block", () => {
    let state = baseRun();
    state = upsertGate(state, { id: "spec-approval", type: "human", question: "Approve SPEC-011?" });
    state = resolveGate(state, "spec-approval", {
      result: "passed",
      decision: { approved: true, by: "munichdeveloper", at: new Date().toISOString() },
    });
    expect(hasOpenHumanGate(state)).toBeUndefined();
    expect(computeNextAction(state).action).toBe("advance-phase");
  });

  it("a rejected human gate resolves (no longer 'open') but surfaces as human-gate-rejected", () => {
    let state = baseRun();
    state = upsertGate(state, { id: "merge-approval", type: "human", question: "Merge PR #1?" });
    state = resolveGate(state, "merge-approval", {
      result: "failed",
      decision: { approved: false, by: "munichdeveloper", at: new Date().toISOString() },
    });
    expect(hasOpenHumanGate(state)).toBeUndefined();
    expect(computeNextAction(state).action).toBe("human-gate-rejected");
  });

  it("acknowledging a rejected gate clears human-gate-rejected and allows progress again", () => {
    let state = baseRun();
    state = upsertGate(state, { id: "merge-approval", type: "human", question: "Merge PR #1?" });
    state = resolveGate(state, "merge-approval", {
      result: "failed",
      decision: { approved: false, by: "munichdeveloper", at: new Date().toISOString() },
    });
    state = acknowledgeRejectedGate(state, "merge-approval", "run cancelled, see follow-up run");
    expect(computeNextAction(state).action).toBe("advance-phase");
  });

  it("escalates once the automatic iteration cap is reached", () => {
    let state = baseRun();
    for (let i = 0; i < state.maxAutomaticIterations; i++) {
      const started = startIteration(state);
      state = finishIteration(started.state, started.iteration.index, "failed", ["still broken"]);
    }
    expect(computeNextAction(state).action).toBe("escalate-iteration-cap");
  });

  it("continues after a human resolves the automatic iteration-cap escalation", () => {
    let state = baseRun();
    for (let i = 0; i < state.maxAutomaticIterations; i++) {
      const started = startIteration(state);
      state = finishIteration(started.state, started.iteration.index, "failed", ["still broken"]);
    }
    state = upsertGate(state, {
      id: "needs-human-escalation",
      type: "human",
      question: "Continue manually?",
    });
    state = resolveGate(state, "needs-human-escalation", {
      result: "passed",
      decision: { approved: true, by: "test", at: new Date().toISOString() },
    });

    expect(computeNextAction(state).action).toBe("advance-phase");
    expect(transitionPhase(state, "spec").phase).toBe("spec");
  });

  it("does not escalate below the iteration cap", () => {
    let state = baseRun();
    const started = startIteration(state);
    state = finishIteration(started.state, started.iteration.index, "failed", ["one failure"]);
    expect(computeNextAction(state).action).toBe("advance-phase");
  });

  it("reports run-complete once phase is complete and no gates are open", () => {
    let state = baseRun();
    state = { ...state, phase: "complete" };
    expect(computeNextAction(state).action).toBe("run-complete");
  });

  it("blocks on pending and failed technical gates", () => {
    let state = baseRun();
    state = upsertGate(state, { id: "verification", type: "review" });
    expect(computeNextAction(state).action).toBe("await-technical-gate");
    expect(() => transitionPhase(state, "spec")).toThrow(/technical gate 'verification' is pending/);

    state = resolveGate(state, "verification", { result: "failed", evidence: ["ci/run/1"] });
    expect(computeNextAction(state).action).toBe("technical-gate-failed");
    expect(() => transitionPhase(state, "spec")).toThrow(/technical gate 'verification' is failed/);

    state = resolveGate(state, "verification", { result: "passed", evidence: ["ci/run/2"] });
    expect(transitionPhase(state, "spec").phase).toBe("spec");
  });

  it("allows only an idempotent or single-step phase transition", () => {
    const state = baseRun();
    expect(transitionPhase(state, "requirement")).toBe(state);
    expect(() => transitionPhase(state, "implementation")).toThrow(/invalid phase transition/);
    const spec = transitionPhase(state, "spec");
    expect(() => transitionPhase(spec, "requirement")).toThrow(/invalid phase transition/);
  });

  it("requires persisted delivery merge evidence before complete", () => {
    const approvedHeadSha = "a".repeat(40);
    const mergeCommitSha = "b".repeat(40);
    const gateId = `merge-approval-pr47-sha${approvedHeadSha.slice(0, 8)}`;
    let state = {
      ...baseRun(),
      phase: "merge" as const,
      deliveryPullRequest: 47,
      deliveryHeadSha: approvedHeadSha,
    };
    expect(() => transitionPhase(state, "complete")).toThrow(/persisted delivery merge evidence/);
    state = upsertGate(state, { id: gateId, type: "human", question: "Approve delivery merge?" });
    state = resolveGate(state, gateId, {
      result: "passed",
      decision: { approved: true, by: "test", at: new Date().toISOString() },
    });
    expect(computeNextAction(state).action).toBe("await-technical-gate");
    expect(() => transitionPhase(state, "complete")).toThrow(/persisted delivery merge evidence/);

    state = recordDeliveryMergeEffect(state, {
      pullRequest: 47,
      approvedHeadSha,
      mergeCommitSha,
      mergedAt: "2026-08-18T13:19:11Z",
    });

    expect(recordDeliveryMergeEffect(state, {
      pullRequest: 47,
      approvedHeadSha,
      mergeCommitSha,
      mergedAt: "2026-08-18T13:19:11Z",
    })).toBe(state);
    expect(state.deliveryMergeCommitSha).toBe(mergeCommitSha);
    expect(state.deliveryMergedAt).toBe("2026-08-18T13:19:11Z");
    expect(transitionPhase(state, "complete").phase).toBe("complete");
  });

  it("skips delivery merge-effect persistence for implementation PR merge events", () => {
    let state = bindDeliveryPullRequest(baseRun(), 47, "a".repeat(40));
    state = bindImplementationPullRequest(state, 48, "b".repeat(40));

    expect(classifyDeliveryPrMergeEffect(state, 48)).toEqual({
      kind: "skip",
      deliveryPullRequest: 47,
      observedPullRequest: 48,
    });
    expect(classifyDeliveryPrMergeEffect(state, 47)).toEqual({
      kind: "record",
      deliveryPullRequest: 47,
    });
  });

  it("binds one PR, permits a new checkpoint SHA, and invalidates review evidence", () => {
    const state = baseRun();
    const sha = "a".repeat(40);
    let bound = bindPullRequest(state, 42, sha);
    expect(bound.pullRequest).toBe(42);
    expect(bound.pullRequestHeadSha).toBe(sha);
    expect(bindPullRequest(bound, 42, sha)).toBe(bound);
    expect(bindPullRequest(bound, 42, sha.toUpperCase())).toBe(bound);
    expect(() => bindPullRequest(bound, 43, sha)).toThrow(/already bound to PR/);

    bound = upsertGate(bound, { id: "verification", type: "review" });
    bound = resolveGate(bound, "verification", { result: "passed", evidence: ["ci/old"] });
    const rebound = bindPullRequest(bound, 42, "b".repeat(40));
    expect(rebound.pullRequestHeadSha).toBe("b".repeat(40));
    expect(rebound.gates.find((gate) => gate.id === "verification")?.result).toBe("pending");
    expect(rebound.gates.find((gate) => gate.id === "verification")?.evidence).toBeUndefined();
    expect(() => bindPullRequest(state, 42, "short")).toThrow(/full 40-character/);
  });
});
