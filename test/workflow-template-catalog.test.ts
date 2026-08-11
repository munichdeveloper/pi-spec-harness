import { describe, expect, it } from "vitest";
import {
  BUG_WORKFLOW_REFERENCE_MARKER,
  BUG_WORKFLOW_REFERENCE_PATH,
  DEFAULT_BUG_TRIAGE_WORKFLOW_REF,
  renderBugWorkflowReference,
} from "../src/bug/workflow-reference.js";
import {
  LABEL_APPROVAL_BUNDLING_REFERENCE_MARKER,
  LABEL_APPROVAL_BUNDLING_REFERENCE_PATH,
  SPEC_TO_ISSUE_REFERENCE_MARKER,
  SPEC_TO_ISSUE_REFERENCE_PATH,
  WORKFLOW_TEMPLATE_CATALOG,
  findWorkflowTemplate,
  renderLabelApprovalBundlingReference,
  renderSpecToIssueReference,
  resolveWorkflowInstallPlan,
} from "../src/workflows/template-catalog.js";
import { decideWorkflowInstall } from "../src/workflows/install-decision.js";

describe("WORKFLOW_TEMPLATE_CATALOG", () => {
  it("TAC-01: includes the migrated bug-triage entry unchanged (path/marker/default ref)", () => {
    const entry = findWorkflowTemplate("bug-triage");
    expect(entry).toBeDefined();
    expect(entry!.targetPath).toBe(BUG_WORKFLOW_REFERENCE_PATH);
    expect(entry!.marker).toBe(BUG_WORKFLOW_REFERENCE_MARKER);
    expect(entry!.defaultRef).toBe(DEFAULT_BUG_TRIAGE_WORKFLOW_REF);
  });

  it("TAC-02: catalog entry's renderReference() is byte-identical to renderBugWorkflowReference() for identical params", () => {
    const entry = findWorkflowTemplate("bug-triage")!;
    const options = { harnessRef: "v9.9.9", reviewer: "octocat" };
    expect(entry.renderReference(options)).toBe(renderBugWorkflowReference(options));
  });

  it("TAC-03: bug-triage catalog entry with no options matches renderBugWorkflowReference() defaults", () => {
    const entry = findWorkflowTemplate("bug-triage")!;
    expect(entry.renderReference()).toBe(renderBugWorkflowReference());
    expect(entry.renderReference().startsWith(BUG_WORKFLOW_REFERENCE_MARKER)).toBe(true);
  });

  it("registers spec-to-issue and label-approval-bundling as further catalog entries (SPEC-007 TAC-10)", () => {
    const specToIssue = findWorkflowTemplate("spec-to-issue")!;
    const labelBundling = findWorkflowTemplate("label-approval-bundling")!;
    expect(specToIssue.targetPath).toBe(SPEC_TO_ISSUE_REFERENCE_PATH);
    expect(specToIssue.marker).toBe(SPEC_TO_ISSUE_REFERENCE_MARKER);
    expect(labelBundling.targetPath).toBe(LABEL_APPROVAL_BUNDLING_REFERENCE_PATH);
    expect(labelBundling.marker).toBe(LABEL_APPROVAL_BUNDLING_REFERENCE_MARKER);
    expect(WORKFLOW_TEMPLATE_CATALOG.map((t) => t.name)).toEqual(
      expect.arrayContaining(["bug-triage", "spec-to-issue", "label-approval-bundling"]),
    );
  });

  it("findWorkflowTemplate returns undefined for unknown names", () => {
    expect(findWorkflowTemplate("does-not-exist")).toBeUndefined();
  });

  it("renders a minimal spec-to-issue reference file with configurable spec-path-glob", () => {
    const rendered = renderSpecToIssueReference({ specPathGlob: "docs/specs/**/*.md", harnessRef: "v1.2.3" });
    expect(rendered).toContain(SPEC_TO_ISSUE_REFERENCE_MARKER);
    expect(rendered).toContain("push:");
    expect(rendered).toContain("docs/specs/**/*.md");
    expect(rendered).toContain("uses: munichdeveloper/pi-spec-harness/.github/workflows/spec-to-issue.yml@v1.2.3");
    expect(rendered).toContain("harness-ref: 'v1.2.3'");
  });

  it("renders a minimal label-approval-bundling reference file with configurable labels", () => {
    const rendered = renderLabelApprovalBundlingReference({
      harnessRef: "8f7e6d5c4b3a29180706050403020100ffeeddcc",
      triggerLabel: "harness:approved-for-agent",
      targetLabels: ["status:ready", "ai:allowed"],
    });
    expect(rendered).toContain(LABEL_APPROVAL_BUNDLING_REFERENCE_MARKER);
    expect(rendered).toContain("issues:");
    expect(rendered).toContain("types: [labeled]");
    expect(rendered).toContain("harness:approved-for-agent");
    expect(rendered).toContain('["status:ready","ai:allowed"]');
    expect(rendered).toContain("harness-ref: '8f7e6d5c4b3a29180706050403020100ffeeddcc'");
  });
});

describe("decideWorkflowInstall (generic, TAC-05)", () => {
  const marker = "# Managed by pi-spec-harness: some-template v1";

  it("create when file is missing", () => {
    expect(decideWorkflowInstall(undefined, "expected", marker)).toBe("create");
  });

  it("noop when content is identical", () => {
    expect(decideWorkflowInstall("same", "same", marker)).toBe("noop");
  });

  it("update-managed when marker present but content differs", () => {
    const existing = `${marker}\nold-content`;
    expect(decideWorkflowInstall(existing, "new-content", marker)).toBe("update-managed");
  });

  it("conflict when unmanaged content exists without the marker", () => {
    expect(decideWorkflowInstall("hand-written workflow", "expected", marker)).toBe("conflict");
  });

  it("is used independent of which catalog entry's marker is passed", () => {
    for (const entry of WORKFLOW_TEMPLATE_CATALOG) {
      expect(decideWorkflowInstall(undefined, entry.renderReference(), entry.marker)).toBe("create");
      expect(decideWorkflowInstall(entry.renderReference(), entry.renderReference(), entry.marker)).toBe("noop");
    }
  });
});

describe("resolveWorkflowInstallPlan (TAC-04/TAC-07)", () => {
  it("TAC-04: throws for an unknown template name and validates before any write would occur", () => {
    expect(() => resolveWorkflowInstallPlan({ installWorkflows: "unknown-name" })).toThrow(/unknown workflow template 'unknown-name'/);
  });

  it("returns an empty plan when nothing is requested", () => {
    expect(resolveWorkflowInstallPlan({})).toEqual([]);
  });

  it("returns exactly the requested, de-duplicated names", () => {
    expect(resolveWorkflowInstallPlan({ installWorkflows: "spec-to-issue,spec-to-issue,label-approval-bundling" })).toEqual([
      "spec-to-issue",
      "label-approval-bundling",
    ]);
  });

  it("TAC-07: combining --install-bug-workflow with --install-workflows never lists bug-triage twice", () => {
    const plan = resolveWorkflowInstallPlan({ installBugWorkflow: true, installWorkflows: "bug-triage,spec-to-issue" });
    expect(plan.filter((n) => n === "bug-triage")).toHaveLength(1);
    expect(plan).toEqual(expect.arrayContaining(["bug-triage", "spec-to-issue"]));
  });

  it("adds bug-triage from the legacy flag even when --install-workflows only names other templates", () => {
    const plan = resolveWorkflowInstallPlan({ installBugWorkflow: true, installWorkflows: "spec-to-issue" });
    expect(plan).toEqual(expect.arrayContaining(["bug-triage", "spec-to-issue"]));
  });
});
