import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseReadinessExecutionConfig } from "../src/spec/readiness-execute-command.js";
import { parseReadinessReconcileConfig } from "../src/spec/readiness-reconcile-command.js";
import { runReadinessCommand } from "../src/spec/readiness-executor.js";

describe("SPEC-016 hosted-test fixtures", () => {
  it.each(["readiness-reconcile", "readiness-executor"])("%s passes scenario through environment, not shell interpolation", workflow => {
    const content = readFileSync(`.github/workflows/${workflow}.yml`, "utf8");
    expect(content).toContain("HARNESS_READINESS_SYNTHETIC_SCENARIO: ${{ vars.HARNESS_READINESS_SYNTHETIC_SCENARIO }}");
    expect(content).toContain("if: vars.HARNESS_READINESS_SYNTHETIC == 'true'");
  });
  function configuration(scenario: string) {
    return JSON.parse(execFileSync(process.execPath, ["scripts/prepare-readiness-synthetic.mjs"], {
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: {
        GITHUB_REPOSITORY: "munichdeveloper/pi-spec-harness",
        HARNESS_READINESS_EXECUTOR_WORKFLOW_ID: "42",
        HARNESS_READINESS_RUNTIME_BRANCH: "runtime-test",
        HARNESS_READINESS_SYNTHETIC_SCENARIO: scenario,
      },
    }));
  }
  it.each(["invalid-coordinates", "incomplete-result"])("independently rejects %s", async scenario => {
    const config = configuration(scenario);
    const executor = parseReadinessExecutionConfig(config.executor);
    const task = { kind: "spike", specRevision: executor.contract.specRevision, blocker: executor.contract.blockers[0] };
    const candidate = await runReadinessCommand(executor.agent, task);
    expect(await runReadinessCommand(executor.verifier!, { ...task, candidate })).toMatchObject({ verdict: "failed", verifiedCriteria: [] });
  });
  it("makes exhausted quota visible and refuses direct execution", async () => {
    const executor = parseReadinessExecutionConfig(configuration("quota-unavailable").executor);
    expect(await runReadinessCommand(executor.availability!, { operation: "availability" })).toMatchObject({ available: false });
    await expect(runReadinessCommand(executor.agent, { kind: "implementation" })).rejects.toThrow();
  });
  it("fails execution after a successful availability probe", async () => {
    const executor = parseReadinessExecutionConfig(configuration("agent-failure").executor);
    expect(await runReadinessCommand(executor.availability!, { operation: "availability" })).toMatchObject({ available: true });
    await expect(runReadinessCommand(executor.agent, { kind: "spike" })).rejects.toThrow();
  });
  it("rejects unknown scenario names rather than silently running success", () => {
    expect(() => configuration("typo")).toThrow();
  });
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
    const verified = await runReadinessCommand(executor.verifier!, { ...task, candidate }) as { verdict: string; references: string[] };
    expect(verified).toMatchObject({ verdict: "passed" });
    expect(verified.references.length).toBeGreaterThan(0);
    expect(verified.references.every(reference => new URL(reference).protocol === "https:")).toBe(true);
    expect(await runReadinessCommand(executor.verifier!, { ...task, candidate: { latitude: 0, longitude: 0 } })).toMatchObject({ verdict: "failed" });
    expect(await runReadinessCommand(executor.agent, { kind: "implementation" })).toEqual({ synthetic: true, implementationResult: 10 });
  });
  it("refuses synthetic activation against Immogent or arbitrary consumers", () => {
    expect(() => execFileSync(process.execPath, ["scripts/prepare-readiness-synthetic.mjs"], { env: { GITHUB_REPOSITORY: "munichdeveloper/Immogent" }, stdio: "pipe" })).toThrow();
  });
});
