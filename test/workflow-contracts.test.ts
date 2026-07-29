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
    expect(workflow).not.toContain("sort -V");
    expect(workflow).not.toContain("tail -1");
    expect(workflow).not.toContain("git push");
  });
});
