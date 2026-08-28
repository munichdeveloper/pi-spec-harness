import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseReadinessExecutionConfig } from "../src/spec/readiness-execute-command.js";
import { parseReadinessReconcileConfig } from "../src/spec/readiness-reconcile-command.js";
import { runReadinessCommand } from "../src/spec/readiness-executor.js";

describe("SPEC-016 hosted-test fixtures", () => {
  it("generates bounded local-only configuration and verifies real subprocess output", async () => {
    const output = execFileSync(process.execPath, ["scripts/prepare-readiness-synthetic.mjs"], { encoding: "utf8", env: {
      GITHUB_REPOSITORY: "munichdeveloper/pi-spec-harness", HARNESS_READINESS_EXECUTOR_WORKFLOW_ID: "42", HARNESS_READINESS_RUNTIME_BRANCH: "runtime-test",
    } });
    const config = JSON.parse(output);
    const executor = parseReadinessExecutionConfig(config.executor);
    config.reconcile.executors[0].workflow.workflowRevision = "a".repeat(40);
    expect(parseReadinessReconcileConfig(config.reconcile).costCeiling).toBe(0);
    const task = { kind: "spike", specRevision: config.executor.contract.specRevision, blocker: config.executor.contract.blockers[0] };
    const candidate = await runReadinessCommand(executor.agent, task);
    expect(await runReadinessCommand(executor.verifier!, { ...task, candidate })).toMatchObject({ verdict: "passed" });
    expect(await runReadinessCommand(executor.verifier!, { ...task, candidate: { latitude: 0, longitude: 0 } })).toMatchObject({ verdict: "failed" });
    expect(await runReadinessCommand(executor.agent, { kind: "implementation" })).toEqual({ synthetic: true, implementationResult: 10 });
  });
  it("refuses synthetic activation against Immogent or arbitrary consumers", () => {
    expect(() => execFileSync(process.execPath, ["scripts/prepare-readiness-synthetic.mjs"], { env: { GITHUB_REPOSITORY: "munichdeveloper/Immogent" }, stdio: "pipe" })).toThrow();
  });
});
