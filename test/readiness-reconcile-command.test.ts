import { describe, expect, it } from "vitest";
import { parseReadinessReconcileConfig, probeReadinessExecutors } from "../src/spec/readiness-reconcile-command.js";

function config() {
  return { schemaVersion: 1, repository: "acme/product", branch: "main", specPath: "docs/SPEC-001.md", contract: null,
    costCeiling: 0, audit: { directory: "docs/process-audit/journal", branch: "main" }, executors: [{
      policy: { id: "synthetic", authorized: true, capabilities: ["spike"], maxTaskCost: 0 },
      availability: { executable: process.execPath, args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({available:true})))"], cwd: process.cwd(), timeoutMs: 2000, env: {} },
      workflow: { repository: "acme/product", branch: "executor", workflowId: 42, workflowPath: ".github/workflows/executor.yml", workflowRevision: "a".repeat(40), allowedActorIds: [10] },
    }] };
}
describe("SPEC-016 reconciliation CLI configuration and live availability", () => {
  it("keeps legacy missing readiness metadata unclassified but validates executable authority", () => {
    expect(parseReadinessReconcileConfig(config()).contract).toBeNull();
    const duplicate = config(); duplicate.executors.push(duplicate.executors[0]);
    expect(() => parseReadinessReconcileConfig(duplicate)).toThrow("ambiguous");
    expect(() => parseReadinessReconcileConfig({ ...config(), specPath: "docs/../private.md" })).toThrow("Invalid");
  });
  it("probes availability live without granting authorization", async () => {
    const c = parseReadinessReconcileConfig(config());
    expect((await probeReadinessExecutors(c))[0].available).toBe(true);
    c.executors[0].policy.authorized = false;
    expect((await probeReadinessExecutors(c))[0]).toMatchObject({ authorized: false, available: false });
  });
  it("fails closed for failed probes and over-budget policies", async () => {
    const c = parseReadinessReconcileConfig(config());
    c.executors[0].availability.args = ["-e", "process.exit(1)"];
    expect((await probeReadinessExecutors(c))[0].available).toBe(false);
    c.executors[0].policy.maxTaskCost = 1;
    expect((await probeReadinessExecutors(c))[0].available).toBe(false);
  });
});
