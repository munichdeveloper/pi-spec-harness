import { describe, expect, it } from "vitest";
import {
  BUG_WORKFLOW_REFERENCE_MARKER,
  decideBugWorkflowInstall,
  renderBugWorkflowReference,
} from "../src/bug/workflow-reference.js";

describe("bug workflow reference installer", () => {
  it("renders a thin reference workflow that only triggers and delegates", () => {
    const rendered = renderBugWorkflowReference({ harnessRef: "v9.9.9" });
    expect(rendered).toContain(BUG_WORKFLOW_REFERENCE_MARKER);
    expect(rendered).toContain("issues:");
    expect(rendered).toContain("types: [opened, typed, labeled]");
    expect(rendered).toContain("uses: munichdeveloper/pi-spec-harness/.github/workflows/bug-triage.yml@v9.9.9");
    expect(rendered).toContain("github.event.issue.type.name == 'Bug'");
    expect(rendered).toContain("type:bug");
  });

  it("decides create when file is missing", () => {
    expect(decideBugWorkflowInstall(undefined, "new-content")).toBe("create");
  });

  it("decides noop when content is identical", () => {
    expect(decideBugWorkflowInstall("same", "same")).toBe("noop");
  });

  it("decides managed update when marker is present and content changed", () => {
    const existing = `${BUG_WORKFLOW_REFERENCE_MARKER}\nold`;
    expect(decideBugWorkflowInstall(existing, "new")).toBe("update-managed");
  });

  it("decides conflict when unmanaged content differs", () => {
    expect(decideBugWorkflowInstall("manual-workflow", "expected")).toBe("conflict");
  });
});
