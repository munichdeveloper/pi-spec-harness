import { describe, expect, it } from "vitest";
import {
  computeNextAction,
  finishIteration,
  hasOpenHumanGate,
  initRunState,
  reconcileInit,
  resolveGate,
  startIteration,
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

  it("escalates once the automatic iteration cap is reached", () => {
    let state = baseRun();
    for (let i = 0; i < state.maxAutomaticIterations; i++) {
      const started = startIteration(state);
      state = finishIteration(started.state, started.iteration.index, "failed", ["still broken"]);
    }
    expect(computeNextAction(state).action).toBe("escalate-iteration-cap");
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
});
