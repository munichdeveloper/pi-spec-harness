import { describe, expect, it, vi } from "vitest";
import { readVerifiedReadinessSpikeResult } from "../src/spec/readiness-evidence.js";

function setup() {
  const work = { key: `readiness-${"a".repeat(64)}`, revision: "b".repeat(40), kind: "spike" as const,
    executorId: "synthetic", blockerId: "coordinates", attempt: 1, issue: 96, receipt: "github-actions:123" };
  const policy = { repository: "acme/product", workflowId: 42, workflowPath: ".github/workflows/readiness-executor.yml", workflowRevision: "c".repeat(40), allowedActorIds: [10] };
  const run = { id: 123, workflow_id: 42, path: policy.workflowPath, head_sha: policy.workflowRevision,
    event: "workflow_dispatch", repository: { full_name: policy.repository }, head_repository: { full_name: policy.repository },
    actor: { id: 10 }, triggering_actor: { id: 10 }, display_title: `readiness:${work.key}`, run_attempt: 1,
    status: "completed", conclusion: "success" };
  const artifact = { id: 55, name: `readiness-result-${"a".repeat(64)}-1`, expired: false, size_in_bytes: 1000,
    workflow_run: { id: 123, head_sha: policy.workflowRevision } };
  const result = { schemaVersion: 1, workKey: work.key, attempt: 1, executorId: work.executorId, issue: 96,
    runId: 123, runAttempt: 1, blockerId: work.blockerId, specRevision: work.revision,
    verdict: "passed", verifiedCriteria: ["coordinates exist"], references: ["https://example.org/evidence"], changes: [] };
  const api = { viewReadinessWorkflowRun: vi.fn(async (): Promise<unknown> => structuredClone(run)),
    listReadinessResultArtifacts: vi.fn(async (): Promise<unknown[]> => [structuredClone(artifact)]),
    downloadReadinessResult: vi.fn(async (): Promise<unknown> => structuredClone(result)) };
  return { work, policy, run, artifact, result, api };
}
describe("SPEC-016 trusted workflow spike evidence", () => {
  it("accepts only a bound artifact and includes the independently verified workflow evidence", async () => {
    const f = setup();
    const result = await readVerifiedReadinessSpikeResult(f.work, f.policy, f.api);
    expect(result?.verdict).toBe("passed");
    expect(result?.references).toContain("https://github.com/acme/product/actions/runs/123/attempts/1");
    expect(f.api.viewReadinessWorkflowRun).toHaveBeenCalledTimes(2);
  });
  it("waits for running work but does not treat failed workflows as successful research", async () => {
    const f = setup(); f.run.status = "in_progress";
    expect(await readVerifiedReadinessSpikeResult(f.work, f.policy, f.api)).toBeUndefined();
    expect(f.api.downloadReadinessResult).not.toHaveBeenCalled();
    f.run.status = "completed"; f.run.conclusion = "failure";
    await expect(readVerifiedReadinessSpikeResult(f.work, f.policy, f.api)).rejects.toThrow("failed");
  });
  it("rejects wrong producer, workflow revision, run identity and fork before download", async () => {
    for (const patch of [{ actor: { id: 11 } }, { triggering_actor: { id: 11 } }, { workflow_id: 99 },
      { head_sha: "d".repeat(40) }, { event: "pull_request" }, { display_title: "other" },
      { head_repository: { full_name: "fork/product" } }]) {
      const f = setup(); Object.assign(f.run, patch);
      await expect(readVerifiedReadinessSpikeResult(f.work, f.policy, f.api)).rejects.toThrow("Untrusted");
      expect(f.api.downloadReadinessResult).not.toHaveBeenCalled();
    }
  });
  it("rejects missing, duplicate, expired or oversized artifacts", async () => {
    for (const artifacts of [[], [setup().artifact, setup().artifact], [{ ...setup().artifact, expired: true }],
      [{ ...setup().artifact, size_in_bytes: 300000 }]]) {
      const f = setup(); f.api.listReadinessResultArtifacts.mockResolvedValue(artifacts);
      await expect(readVerifiedReadinessSpikeResult(f.work, f.policy, f.api)).rejects.toThrow();
      expect(f.api.downloadReadinessResult).not.toHaveBeenCalled();
    }
  });
  it("rejects another attempt, revision, executor, issue and malformed payload", async () => {
    for (const patch of [{ attempt: 2 }, { specRevision: "wrong" }, { executorId: "other" }, { issue: 97 },
      { runAttempt: 2 }, { verifiedCriteria: "all" }, { references: [] }, { changes: ["unknown"] }]) {
      const f = setup(); f.api.downloadReadinessResult.mockResolvedValue({ ...f.result, ...patch });
      await expect(readVerifiedReadinessSpikeResult(f.work, f.policy, f.api)).rejects.toThrow("bound readiness result");
    }
  });
  it("detects a rerun while the artifact is being retrieved", async () => {
    const f = setup(); f.api.viewReadinessWorkflowRun.mockResolvedValueOnce(f.run).mockResolvedValueOnce({ ...f.run, run_attempt: 2 });
    await expect(readVerifiedReadinessSpikeResult(f.work, f.policy, f.api)).rejects.toThrow("changed during");
  });
  it("preserves failed verdicts and boundary changes for the bounded retry/human decision", async () => {
    const f = setup(); f.api.downloadReadinessResult.mockResolvedValue({ ...f.result, verdict: "failed", changes: ["cost"] });
    expect(await readVerifiedReadinessSpikeResult(f.work, f.policy, f.api)).toMatchObject({ verdict: "failed", changes: ["cost"] });
  });
});
