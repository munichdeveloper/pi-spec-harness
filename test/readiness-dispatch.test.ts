import { describe, expect, it, vi } from "vitest";
import { dispatchReadinessWork, findReadinessDispatch } from "../src/spec/readiness-dispatch.js";

function setup() {
  const work = { key: `readiness-${"a".repeat(64)}`, revision: "b".repeat(40), kind: "spike" as const, executorId: "synthetic", attempt: 1 };
  const policy = { repository: "acme/product", workflowId: 42, workflowPath: ".github/workflows/readiness-executor.yml", workflowRevision: "c".repeat(40), allowedActorIds: [10], branch: "main" };
  const run = { id: 123, workflow_id: 42, path: policy.workflowPath, head_sha: policy.workflowRevision,
    event: "workflow_dispatch", display_title: `readiness:${work.key}`, repository: { full_name: policy.repository },
    head_repository: { full_name: policy.repository }, actor: { id: 10 }, triggering_actor: { id: 10 } };
  const runs: unknown[] = [];
  const api = { listReadinessWorkflowRuns: vi.fn(async () => runs), viewReadinessWorkflowRun: vi.fn(async () => run),
    getBranchSha: vi.fn(async () => policy.workflowRevision), dispatchReadinessWorkflow: vi.fn(async () => { runs.push(run); }) };
  return { work, policy, run, runs, api, wait: vi.fn(async () => {}) };
}
describe("SPEC-016 explicit workflow dispatch", () => {
  it("dispatches once and resolves the actual run receipt", async () => {
    const f = setup();
    expect(await dispatchReadinessWork({ work: f.work, policy: f.policy, runIssue: 97 }, f.api, f.wait)).toBe("github-actions:123");
    expect(f.api.dispatchReadinessWorkflow).toHaveBeenCalledWith("acme/product", 42, "main", {
      "run-issue": "97", "work-key": f.work.key, "spec-revision": f.work.revision, "workflow-revision": f.policy.workflowRevision,
    });
    await dispatchReadinessWork({ work: f.work, policy: f.policy, runIssue: 97 }, f.api, f.wait);
    expect(f.api.dispatchReadinessWorkflow).toHaveBeenCalledTimes(1);
  });
  it("recovers a request accepted before its response was lost", async () => {
    const f = setup(); f.api.dispatchReadinessWorkflow.mockImplementationOnce(async () => { f.runs.push(f.run); throw new Error("response lost"); });
    expect(await dispatchReadinessWork({ work: f.work, policy: f.policy, runIssue: 97 }, f.api, f.wait)).toBe("github-actions:123");
    expect(f.api.dispatchReadinessWorkflow).toHaveBeenCalledTimes(1);
  });
  it("does not fabricate receipts or repeatedly submit while visibility is delayed", async () => {
    const f = setup(); f.api.dispatchReadinessWorkflow.mockResolvedValue(undefined);
    await expect(dispatchReadinessWork({ work: f.work, policy: f.policy, runIssue: 97 }, f.api, f.wait)).rejects.toThrow("not yet visible");
    expect(f.wait).toHaveBeenCalledTimes(4);
    expect(f.api.dispatchReadinessWorkflow).toHaveBeenCalledTimes(1);
  });
  it("refuses a moved workflow revision before submitting", async () => {
    const f = setup(); f.api.getBranchSha.mockResolvedValue("d".repeat(40));
    await expect(dispatchReadinessWork({ work: f.work, policy: f.policy, runIssue: 97 }, f.api, f.wait)).rejects.toThrow("branch moved");
    expect(f.api.dispatchReadinessWorkflow).not.toHaveBeenCalled();
  });
  it("ignores untrusted runs and chooses a deterministic transport receipt", async () => {
    const f = setup(); f.runs.push({ ...f.run, id: 100, actor: { id: 99 } }, { ...f.run, id: 124 }, f.run);
    expect(await findReadinessDispatch(f.work, f.policy, f.api)).toBe("github-actions:123");
    expect(await findReadinessDispatch({ ...f.work, receipt: "github-actions:123" }, f.policy, f.api)).toBe("github-actions:123");
    f.api.viewReadinessWorkflowRun.mockResolvedValue({ ...f.run, head_sha: "other" });
    await expect(findReadinessDispatch({ ...f.work, receipt: "github-actions:123" }, f.policy, f.api)).rejects.toThrow("Canonical");
  });
});
