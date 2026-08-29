import { describe, expect, it, vi } from "vitest";
import { disposeSyntheticReadinessEvidence } from "../src/spec/readiness-lifecycle.js";
import type { RunState } from "../src/state/types.js";

function fixture() {
  const state: RunState = { schemaVersion: 1, repository: "munichdeveloper/pi-spec-harness", requirement: "REQ-900001",
    runId: "readiness-spec-900013", spec: "SPEC-900013", phase: "issue", issue: 167, gates: [], iterations: [],
    maxAutomaticIterations: 3, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  state.readiness = { schemaVersion: 1, revision: "a".repeat(40), implementationKey: `readiness-${"b".repeat(64)}`,
    work: [{ key: `readiness-${"c".repeat(64)}`, revision: "a".repeat(40), kind: "spike", executorId: "synthetic",
      attempt: 1, issue: 168, execution: { receipt: "github-actions:1", status: "completed", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z" } }] };
  let durable = structuredClone(state);
  const store = { load: async () => structuredClone(durable), save: async (next: RunState) => {
    durable = structuredClone(next);
    Object.assign(state, structuredClone(next));
  } };
  const api = { listReadinessIssues: vi.fn().mockResolvedValue([
    { number: 167, state: "OPEN", title: "implementation", body: "" },
    { number: 168, state: "OPEN", title: "spike", body: "" },
  ]), closeIssue: vi.fn().mockResolvedValue(undefined) };
  return { state, store, api };
}

describe("synthetic readiness lifecycle disposition", () => {
  it("retains the tracking run and closes only child issues with a durable checkpoint", async () => {
    const { state, store, api } = fixture();
    const result = await disposeSyntheticReadinessEvidence(store, { outcome: "negative-proof", reason: "stale binding rejected",
      evidence: ["https://github.com/example/actions/runs/1"], occurredAt: "2026-01-01T00:02:00.000Z" }, api as never);
    expect(result).toMatchObject({ phase: "issue", trackingIssueRetained: true });
    expect(api.closeIssue.mock.calls.map(call => call[1])).toEqual([167, 168]);
    expect(state.readiness?.lifecycleDisposition).toMatchObject({ status: "disposed", closedIssues: [167, 168] });
  });

  it("is idempotent after disposal", async () => {
    const { store, api } = fixture();
    const input = { outcome: "negative-proof" as const, reason: "stale binding rejected",
      evidence: ["https://github.com/example/actions/runs/1"], occurredAt: "2026-01-01T00:02:00.000Z" };
    await disposeSyntheticReadinessEvidence(store, input, api as never);
    await disposeSyntheticReadinessEvidence(store, input, api as never);
    expect(api.closeIssue).toHaveBeenCalledTimes(2);
  });

  it("rejects product runs and claimed work", async () => {
    const { store, api } = fixture();
    const product = await store.load();
    product.spec = "SPEC-016";
    await store.save(product);
    await expect(disposeSyntheticReadinessEvidence(store, { outcome: "negative-proof", reason: "x",
      evidence: ["https://example.test"], occurredAt: "2026-01-01T00:00:00.000Z" }, api as never)).rejects.toThrow("restricted");
    const claimed = await store.load();
    claimed.spec = "SPEC-900013";
    claimed.readiness!.work[0].execution!.status = "claimed";
    await store.save(claimed);
    await expect(disposeSyntheticReadinessEvidence(store, { outcome: "negative-proof", reason: "x",
      evidence: ["https://example.test"], occurredAt: "2026-01-01T00:00:00.000Z" }, api as never)).rejects.toThrow("claimed work");
  });
});
