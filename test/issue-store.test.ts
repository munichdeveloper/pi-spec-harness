import { describe, expect, it } from "vitest";
import { parseStateFromBody, renderStateBody, runIssueTitle } from "../src/state/issue-store.js";
import { initRunState, upsertGate } from "../src/state/state-machine.js";

describe("issue-store body rendering", () => {
  it("round-trips run-state through renderStateBody/parseStateFromBody", () => {
    const state = initRunState({
      runId: "roundtrip-001",
      repository: "munichdeveloper/Immogent",
      requirement: "REQ-001",
      spec: "SPEC-099",
    });
    const body = renderStateBody(state);
    const parsed = parseStateFromBody(body);
    expect(parsed).toEqual(state);
  });

  it("includes an open human gate's question in the rendered summary", () => {
    let state = initRunState({
      runId: "roundtrip-002",
      repository: "munichdeveloper/Immogent",
      requirement: "REQ-001",
      spec: "SPEC-099",
    });
    state = upsertGate(state, { id: "merge-approval", type: "human", question: "Merge freigeben?" });
    const body = renderStateBody(state);
    expect(body).toContain("Offenes Human-Gate: `merge-approval`");
    expect(body).toContain("Merge freigeben?");
    expect(parseStateFromBody(body)).toEqual(state);
  });

  it("throws a clear error when the state block is missing", () => {
    expect(() => parseStateFromBody("no state here")).toThrow(/harness:state block/);
  });

  it("builds a deterministic, unique tracking issue title per run id", () => {
    expect(runIssueTitle("immogent-run-005")).toBe("[Harness Run] immogent-run-005");
  });
});
