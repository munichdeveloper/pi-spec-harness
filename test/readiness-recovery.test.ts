import { afterEach, describe, expect, it, vi } from "vitest";
import { github } from "../src/github/gh.js";
import { recoverReadinessTransport } from "../src/spec/readiness-recovery.js";
import { initRunState } from "../src/state/state-machine.js";
afterEach(() => vi.restoreAllMocks());
function setup() {
  let clock = Date.parse("2026-08-28T00:00:00Z");
  let state = initRunState({ repository: "acme/product", runId: "test", requirement: "REQ-001", spec: "SPEC-001" });
  const key = `readiness-${"a".repeat(64)}`;
  state.readiness = { schemaVersion: 1, revision: "revision", implementationKey: "issue", work: [{ key, revision: "revision", kind: "spike", blockerId: "b", executorId: "test", attempt: 1, issue: 96, receipt: "github-actions:123" }] };
  const store = { load: async () => structuredClone(state), save: async (next: typeof state) => { state = structuredClone(next); } };
  const policy = { repository: "acme/product", branch: "runtime", workflowId: 42, workflowPath: ".github/workflows/executor.yml", workflowRevision: "b".repeat(40), allowedActorIds: [10] };
  const run = { id: 123, workflow_id: 42, path: policy.workflowPath, head_sha: policy.workflowRevision,
    event: "workflow_dispatch", display_title: `readiness:${key}`, repository: { full_name: policy.repository }, head_repository: { full_name: policy.repository }, actor: { id: 10 }, triggering_actor: { id: 10 }, status: "completed", conclusion: "cancelled", run_attempt: 1 };
  vi.spyOn(github, "viewReadinessWorkflowRun").mockImplementation(async () => run);
  vi.spyOn(github, "rerunReadinessWorkflow").mockResolvedValue();
  const executor = { id: "test", authorized: true, available: true, capabilities: ["spike" as const], maxTaskCost: 0 };
  const input = { store, workflow: () => policy, currentExecutors: async () => [executor], costCeiling: 0, audit: vi.fn(async () => {}), now: () => clock };
  return { input, state: () => state, run, executor, tick: () => { clock += 61000; } };
}
describe("SPEC-016 bounded transport recovery", () => {
  it("reuses the original workflow receipt and backs off before retrying", async () => {
    const f = setup();
    expect((await recoverReadinessTransport(f.input))?.reason).toBe("transport-retry-submitted");
    expect(github.rerunReadinessWorkflow).toHaveBeenCalledWith("acme/product", 123);
    expect(f.state().readiness?.work[0].receipt).toBe("github-actions:123");
    expect((await recoverReadinessTransport(f.input))?.reason).toBe("transport-retry-backoff");
    expect(github.rerunReadinessWorkflow).toHaveBeenCalledTimes(1);
  });
  it("bounds repeated failed transport submissions and exposes a human decision", async () => {
    const f = setup();
    for (let i = 0; i < 3; i++) { await recoverReadinessTransport(f.input); f.tick(); }
    expect((await recoverReadinessTransport(f.input))?.action).toBe("human-decision");
    expect(github.rerunReadinessWorkflow).toHaveBeenCalledTimes(3);
  });
  it("never retries uncertain agent execution but can republish completed output", async () => {
    const f = setup(); const state = await f.input.store.load();
    state.readiness!.work[0].execution = { receipt: "github-actions:123", status: "claimed", startedAt: "now" };
    await f.input.store.save(state);
    expect((await recoverReadinessTransport(f.input))?.reason).toBe("agent-execution-outcome-requires-reconciliation");
    expect(github.rerunReadinessWorkflow).not.toHaveBeenCalled();
    state.readiness!.work[0].execution.status = "completed";
    await f.input.store.save(state); f.executor.available = false;
    expect((await recoverReadinessTransport(f.input))?.reason).toBe("transport-retry-submitted");
  });
  it("waits for available quota before retrying an unstarted task", async () => {
    const f = setup(); f.executor.available = false;
    expect((await recoverReadinessTransport(f.input))?.action).toBe("await-executor");
    expect(github.rerunReadinessWorkflow).not.toHaveBeenCalled();
  });
  it("persists the submission budget even when the API response is lost", async () => {
    const f = setup(); vi.mocked(github.rerunReadinessWorkflow).mockRejectedValueOnce(new Error("response lost"));
    await expect(recoverReadinessTransport(f.input)).rejects.toThrow("response lost");
    expect(f.state().readiness?.work[0].transportRecovery?.submissions).toBe(1);
    f.run.status = "in_progress"; f.run.run_attempt = 2;
    expect(await recoverReadinessTransport(f.input)).toBeUndefined();
    expect(github.rerunReadinessWorkflow).toHaveBeenCalledTimes(1);
  });
});
