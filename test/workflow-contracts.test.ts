import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("GitHub workflow contracts", () => {
  it("resumes only the exact tracking issue that received a decision label", async () => {
    const workflow = await readFile(".github/workflows/harness-gate-trigger.yml", "utf8");

    expect(workflow).toContain("issues:");
    expect(workflow).toContain("harness:run");
    expect(workflow).toContain("github.event.issue.number");
    expect(workflow).toContain("GITHUB_EVENT_PATH");
    expect(workflow).toContain("try capture");
    expect(workflow).toContain("catch {}");
    expect(workflow).toContain('--run-id "${{ steps.run.outputs.run_id }}"');
    // TAC-04/TAC-12: after a gate decision the orchestrator (not a single advance) is called
    expect(workflow).toContain("npm run harness -- orchestrate");
    expect(workflow).not.toContain("sort -V");
    expect(workflow).not.toContain("tail -1");
    expect(workflow).not.toContain("git push");
  });

  it("triggers on pull_request closed events for implementation PR orchestration (TAC-12)", async () => {
    const workflow = await readFile(".github/workflows/harness-gate-trigger.yml", "utf8");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("types: [closed]");
    // Serialises across concurrent runs
    expect(workflow).toContain("cancel-in-progress: false");
  });
});
