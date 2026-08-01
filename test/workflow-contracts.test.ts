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
    expect(workflow).toContain("npm run harness -- advance");
    expect(workflow).toContain('! "$gate_id" =~ ^merge-approval-');
    expect(workflow).toContain("phase completion waits for the bound merge effect");
    expect(workflow).not.toContain("sort -V");
    expect(workflow).not.toContain("tail -1");
    expect(workflow).not.toContain("git push");
  });

  it("documents the target-repository merge transaction and check permissions", async () => {
    const [workflowDoc, skill, handover] = await Promise.all([
      readFile("docs/event-driven-workflow.md", "utf8"),
      readFile("skills/pi-spec-harness/SKILL.md", "utf8"),
      readFile("docs/HANDOVER.md", "utf8"),
    ]);
    const contract = [workflowDoc, skill, handover].join("\n");

    expect(contract).toContain("checks: read");
    expect(contract).toContain("statuses: read");
    expect(contract).toContain("Merge-Effekt");
    expect(contract).toContain("Reconcile");
    expect(contract).toContain("Tracking-Issue");
  });
});
