import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("GitHub workflow contracts", () => {
  it("resumes only the exact tracking issue that received a decision label", async () => {
    const workflow = await readFile(".github/workflows/harness-gate-trigger.yml", "utf8");

    expect(workflow).toContain("issues:");
    expect(workflow).toContain("harness:run");
    expect(workflow).toContain("GITHUB_EVENT_PATH");
    expect(workflow).toContain("try capture");
    expect(workflow).toContain("catch {}");
    expect(workflow).toContain('--run-id "${{ steps.run.outputs.run_id }}"');
    expect(workflow).toContain("npm run harness -- advance");
    expect(workflow).not.toContain("sort -V");
    expect(workflow).not.toContain("tail -1");
    expect(workflow).not.toContain("git push");
  });

  // TAC-09: workflow supports workflow_dispatch and push (own file on default branch)
  it("supports workflow_dispatch and push triggers for bootstrap reconciliation (TAC-09)", async () => {
    const workflow = await readFile(".github/workflows/harness-gate-trigger.yml", "utf8");

    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("harness-gate-trigger.yml");
  });

  // TAC-10: repo-wide concurrency, no newest-issue selection
  it("serialises gate processing repo-wide and does not select by newest issue (TAC-10)", async () => {
    const workflow = await readFile(".github/workflows/harness-gate-trigger.yml", "utf8");

    // Repo-wide concurrency group -- not per-issue
    expect(workflow).toContain("github.repository");
    // The resume job only fires on the issues event, not all events
    expect(workflow).toContain("github.event_name");
    // reconcile command used for bootstrap
    expect(workflow).toContain("reconcile");
    // No "newest issue" selection patterns
    expect(workflow).not.toContain("sort -V");
    expect(workflow).not.toContain("tail -1");
  });
});
