import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const read = (name: string) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
describe("SPEC-016 readiness workflow wiring", () => {
  it("serializes reconciliation and execution with the same non-cancelling lock", () => {
    for (const name of ["readiness-reconcile.yml", "readiness-executor.yml"]) {
      const workflow = read(name);
      expect(workflow).toContain("group: readiness-${{ github.repository }}");
      expect(workflow).toContain("cancel-in-progress: false");
      expect(workflow).toContain("vars.HARNESS_READINESS_ENABLED == 'true'");
      expect(workflow).toContain("ref: ${{ vars.HARNESS_READINESS_RUNTIME_SHA }}");
      expect(workflow).toContain("persist-credentials: false");
      expect(workflow).not.toContain("pull_request_target:");
    }
  });
  it("resumes on executor completion and periodically recovers missed events", () => {
    const workflow = read("readiness-reconcile.yml");
    expect(workflow).toContain("workflows: ['Harness Readiness Executor']");
    expect(workflow).toContain("types: [completed]");
    expect(workflow).toContain("cron: '*/10 * * * *'");
    expect(workflow).toContain("readiness-reconcile --repository");
  });
  it("binds the executor to the pinned runtime and publishes only the verified artifact", () => {
    const workflow = read("readiness-executor.yml");
    expect(workflow).toContain("github.sha == vars.HARNESS_READINESS_RUNTIME_SHA");
    expect(workflow).toContain("inputs.workflow-revision == vars.HARNESS_READINESS_RUNTIME_SHA");
    expect(workflow).toContain("readiness-execute --repository");
    expect(workflow).toContain("envelope.result.artifact");
    expect(workflow).toContain("readiness-result-${process.env.WORK_KEY.slice(10)}-${process.env.GITHUB_RUN_ATTEMPT}");
  });
});
