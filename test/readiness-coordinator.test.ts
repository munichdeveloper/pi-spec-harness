import { describe, expect, it, vi } from "vitest";
import type { RunState } from "../src/state/types.js";
import { reconcileReadiness, type ReadinessPorts } from "../src/spec/readiness-coordinator.js";
import type { VerifiedSpikeEvidence } from "../src/spec/readiness.js";
import { renderStateBody, parseStateFromBody } from "../src/state/issue-store.js";

function setup() {
  let durable: RunState = { schemaVersion: 1, repository: "acme/product", runId: "spec-1", spec: "SPEC-001", requirement: "REQ-001", phase: "issue", gates: [], iterations: [], maxAutomaticIterations: 3, createdAt: "2026-08-27T00:00:00Z", updatedAt: "2026-08-27T00:00:00Z" };
  const store = { load: async () => structuredClone(durable), save: async (s: RunState) => { durable = structuredClone(s); } };
  const accepted = new Map<string, string>();
  let result: VerifiedSpikeEvidence | undefined;
  const executor = { id: "test-agent", authorized: true, available: true, capabilities: ["spike", "implementation"] as Array<"spike" | "implementation">, maxTaskCost: 0 };
  const ports: ReadinessPorts = {
    ensureImplementationIssue: vi.fn(async () => 96),
    ensureSpikeIssue: vi.fn(async () => 97),
    reconcileReadinessLabels: vi.fn(async () => {}),
    currentExecutors: vi.fn(async () => [structuredClone(executor)]),
    findReadinessWork: vi.fn(async key => accepted.get(key)),
    dispatchReadinessWork: vi.fn(async work => { const receipt = `receipt-${work.key}`; accepted.set(work.key, receipt); return receipt; }),
    confirmReadinessAudit: vi.fn(async () => {}),
    confirmSpikeResultAudit: vi.fn(async () => {}),
    readVerifiedSpikeResult: vi.fn(async () => result),
  };
  const context = { specId: "SPEC-001", approved: true, revision: "revision-a", costCeiling: 0, contract: {
    schemaVersion: 1, specRevision: "revision-a", blockers: [{ id: "coordinates", stage: "implementation", kind: "technical", owner: "research", question: "Coordinates?", criteria: ["reproduce"], maxAttempts: 2 }],
  } };
  const success: VerifiedSpikeEvidence = { blockerId: "coordinates", specRevision: "revision-a", verdict: "passed", verifiedCriteria: ["reproduce"], references: ["https://example.org/verified"], changes: [] };
  return { store, ports, context, accepted, executor, success, setResult: (r: VerifiedSpikeEvidence) => { result = r; }, state: () => durable };
}

describe("SPEC-016 durable readiness coordinator (port integration, not workflow E2E)", () => {
  it("reconciles an existing issue, performs a spike and resumes implementation on the same run", async () => {
    const f = setup();
    expect((await reconcileReadiness(f.store, f.context, f.ports)).action).toBe("observe-work");
    expect(f.state().issue).toBe(96);
    const rendered = renderStateBody(f.state());
    expect(rendered).toContain("Readiness / nächste Zuständigkeit");
    expect(rendered).toContain("test-agent");
    expect(parseStateFromBody(rendered).readiness).toEqual(f.state().readiness);
    await reconcileReadiness(f.store, f.context, f.ports);
    expect(f.ports.dispatchReadinessWork).toHaveBeenCalledTimes(1);
    f.setResult(f.success);
    const next = await reconcileReadiness(f.store, f.context, f.ports);
    expect(next.reason).toBe("implementation-dispatched");
    expect(f.state().readiness?.work.map(w => w.kind)).toEqual(["spike", "implementation"]);
    await reconcileReadiness(f.store, f.context, f.ports);
    expect(f.ports.dispatchReadinessWork).toHaveBeenCalledTimes(2);
    expect(f.ports.ensureImplementationIssue).toHaveBeenCalledTimes(1);
    expect(f.ports.confirmSpikeResultAudit).toHaveBeenCalledTimes(1);
  });
  it("recovers dispatch accepted before a crash without sending again", async () => {
    const f = setup();
    vi.mocked(f.ports.dispatchReadinessWork).mockImplementationOnce(async work => { f.accepted.set(work.key, "accepted-before-crash"); throw new Error("crash"); });
    await expect(reconcileReadiness(f.store, f.context, f.ports)).rejects.toThrow("crash");
    expect(f.state().readiness?.work[0].receipt).toBeUndefined();
    await reconcileReadiness(f.store, f.context, f.ports);
    expect(f.ports.dispatchReadinessWork).toHaveBeenCalledTimes(1);
    expect(f.state().readiness?.work[0].receipt).toBe("accepted-before-crash");
  });
  it("retries failed audit confirmation before inspecting results", async () => {
    const f = setup();
    vi.mocked(f.ports.confirmReadinessAudit).mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(reconcileReadiness(f.store, f.context, f.ports)).rejects.toThrow("audit unavailable");
    expect(f.ports.readVerifiedSpikeResult).not.toHaveBeenCalled();
    await reconcileReadiness(f.store, f.context, f.ports);
    expect(f.ports.dispatchReadinessWork).toHaveBeenCalledTimes(1);
    expect(f.state().readiness?.work[0].auditConfirmed).toBe(true);
  });
  it("rechecks availability at dispatch and removes ready disposition", async () => {
    const f = setup(); f.context.contract.blockers = [];
    vi.mocked(f.ports.currentExecutors).mockResolvedValueOnce([f.executor]).mockResolvedValueOnce([{ ...f.executor, available: false }]);
    expect((await reconcileReadiness(f.store, f.context, f.ports)).action).toBe("await-executor");
    expect(f.ports.dispatchReadinessWork).not.toHaveBeenCalled();
    expect(f.ports.reconcileReadinessLabels).toHaveBeenLastCalledWith(96, expect.objectContaining({ action: "await-executor" }));
    expect(f.state().readiness?.decision?.action).toBe("await-executor");
  });
  it("rejects mismatched result and does not persist it", async () => {
    const f = setup(); await reconcileReadiness(f.store, f.context, f.ports);
    f.setResult({ ...f.success, specRevision: "wrong" });
    await expect(reconcileReadiness(f.store, f.context, f.ports)).rejects.toThrow("binding mismatch");
    expect(f.state().readiness?.work[0].result).toBeUndefined();
  });
  it("does not treat issue closure or missing results as completion", async () => {
    const f = setup(); await reconcileReadiness(f.store, f.context, f.ports);
    for (let i = 0; i < 3; i++) expect((await reconcileReadiness(f.store, f.context, f.ports)).reason).toBe("spike-result-pending");
    expect(f.state().readiness?.work).toHaveLength(1);
  });
  it("limits failed spike attempts then escalates on the same run", async () => {
    const f = setup(); await reconcileReadiness(f.store, f.context, f.ports);
    f.setResult({ ...f.success, verdict: "failed" });
    await reconcileReadiness(f.store, f.context, f.ports);
    expect(f.state().readiness?.work).toHaveLength(2);
    expect((await reconcileReadiness(f.store, f.context, f.ports)).action).toBe("human-decision");
    expect(f.ports.dispatchReadinessWork).toHaveBeenCalledTimes(2);
  });
  it("refuses a different spec or changed revision rather than creating competing work", async () => {
    const f = setup();
    await expect(reconcileReadiness(f.store, { ...f.context, specId: "SPEC-002" }, f.ports)).rejects.toThrow("canonical run");
    await reconcileReadiness(f.store, f.context, f.ports);
    expect((await reconcileReadiness(f.store, { ...f.context, revision: "new" }, f.ports)).action).toBe("human-decision");
    expect(f.state().readiness?.decision?.action).toBe("human-decision");
    expect(f.ports.reconcileReadinessLabels).toHaveBeenLastCalledWith(96, expect.objectContaining({ action: "human-decision" }));
    expect(f.ports.dispatchReadinessWork).toHaveBeenCalledTimes(1);
  });
});
