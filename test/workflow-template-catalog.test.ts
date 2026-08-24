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
  PROCESS_AUDIT_RECEIVER_MARKER,
  PROCESS_AUDIT_RECEIVER_PATH,
  DEFAULT_PROCESS_AUDIT_RECEIVER_WORKFLOW_REF,
  REQUIREMENT_TO_SPEC_REFERENCE_MARKER,
  REQUIREMENT_TO_SPEC_REFERENCE_PATH,
  DEFAULT_REQUIREMENT_TO_SPEC_WORKFLOW_REF,
  SPEC_TO_ISSUE_REFERENCE_MARKER,
  SPEC_TO_ISSUE_REFERENCE_PATH,
  WORKFLOW_TEMPLATE_CATALOG,
  findWorkflowTemplate,
  renderLabelApprovalBundlingReference,
  renderProcessAuditReceiver,
  renderRequirementToSpecReference,
  renderReviewFixReference,
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
    expect(rendered).toContain("permissions:\n  contents: read\n  issues: write");
    expect(rendered).not.toContain("secrets: inherit");
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
    expect(rendered).toContain("permissions:\n  contents: read\n  issues: write");
    expect(rendered).not.toContain("secrets: inherit");
  });

  it("renders each reactive reference with its configured catalog default ref", () => {
    expect(renderSpecToIssueReference()).toContain("spec-to-issue.yml@v0.2.2");
    expect(renderSpecToIssueReference()).toContain("harness-ref: 'v0.2.2'");
    expect(renderLabelApprovalBundlingReference()).toContain("label-approval-bundling.yml@v0.2.4");
    expect(renderLabelApprovalBundlingReference()).toContain("harness-ref: 'v0.2.4'");
    expect(renderBugWorkflowReference()).toContain("bug-triage.yml@v0.2.2");
    expect(renderReviewFixReference()).toContain("review-fix.yml@v0.2.4");
    expect(renderReviewFixReference()).toContain("harness-ref: 'v0.2.4'");
  });

  it("renders the trusted review-fix receiver with split triggers and checks permission", () => {
    const rendered = renderReviewFixReference();
    expect(rendered).toContain("pull_request_review:");
    expect(rendered).toContain("issue_comment:");
    expect(rendered).toContain("pull_request_target:");
    expect(rendered).toContain("checks: write");
    expect(rendered).toContain("review-fix-review:");
    expect(rendered).toContain("resolve-review-fix-comment:");
    expect(rendered).toContain("review-fix-comment:");
    expect(rendered).toContain("review-fix-pr-event:");
    expect(rendered).toContain("github.event.pull_request.head.repo.full_name == github.repository");
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

  it("SPEC-010: capability-smoke is a valid installable template", () => {
    expect(() => resolveWorkflowInstallPlan({ installWorkflows: "capability-smoke" })).not.toThrow();
    expect(resolveWorkflowInstallPlan({ installWorkflows: "capability-smoke" })).toEqual(["capability-smoke"]);
  });

  it("SPEC-005/Finding-1: process-audit-receiver is a valid installable template", () => {
    expect(() => resolveWorkflowInstallPlan({ installWorkflows: "process-audit-receiver" })).not.toThrow();
    expect(resolveWorkflowInstallPlan({ installWorkflows: "process-audit-receiver" })).toEqual(["process-audit-receiver"]);
  });
});

describe("SPEC-005: process-audit-receiver catalog entry (Finding 1)", () => {
  it("is registered in the catalog with the correct path, marker and reusable workflow path", () => {
    const entry = findWorkflowTemplate("process-audit-receiver");
    expect(entry).toBeDefined();
    expect(entry!.targetPath).toBe(PROCESS_AUDIT_RECEIVER_PATH);
    expect(entry!.marker).toBe(PROCESS_AUDIT_RECEIVER_MARKER);
    expect(entry!.reusableWorkflowRepoPath).toBe(".github/workflows/process-audit-automation.yml");
    expect(entry!.defaultRef).toBe(DEFAULT_PROCESS_AUDIT_RECEIVER_WORKFLOW_REF);
  });

  it("renderProcessAuditReceiver uses the remote reusable workflow at a pinned ref (not local path, not mutable 'main')", () => {
    const rendered = renderProcessAuditReceiver({ harnessRef: "v0.2.2" });
    expect(rendered).toContain(PROCESS_AUDIT_RECEIVER_MARKER);
    expect(rendered).toContain("repository_dispatch");
    expect(rendered).toContain("process_audit");
    // Must call the remote reusable workflow
    expect(rendered).toContain("uses: munichdeveloper/pi-spec-harness/.github/workflows/process-audit-automation.yml@v0.2.2");
    // Must pass harness-ref so the recorder scripts use the same immutable ref
    expect(rendered).toContain("harness-ref: 'v0.2.2'");
    // Must NOT use the local path (./) — that only works in the harness repo itself
    expect(rendered).not.toContain("uses: ./.github/workflows/process-audit-automation.yml");
    // Must NOT hard-code mutable 'main'
    expect(rendered).not.toContain("harness-ref: main");
  });

  it("renderProcessAuditReceiver defaults to the pinned release ref (not mutable 'main')", () => {
    const rendered = renderProcessAuditReceiver();
    expect(rendered).toContain(`process-audit-automation.yml@${DEFAULT_PROCESS_AUDIT_RECEIVER_WORKFLOW_REF}`);
    expect(rendered).toContain(`harness-ref: '${DEFAULT_PROCESS_AUDIT_RECEIVER_WORKFLOW_REF}'`);
    expect(rendered).not.toContain("harness-ref: main");
  });

  it("renderProcessAuditReceiver accepts a custom journal directory", () => {
    const rendered = renderProcessAuditReceiver({ journalDir: "audit/journal" });
    expect(rendered).toContain("journal-dir: 'audit/journal'");
  });

  it("rendered receiver is parseable by decideWorkflowInstall and treated as managed", () => {
    const rendered = renderProcessAuditReceiver();
    expect(decideWorkflowInstall(undefined, rendered, PROCESS_AUDIT_RECEIVER_MARKER)).toBe("create");
    expect(decideWorkflowInstall(rendered, rendered, PROCESS_AUDIT_RECEIVER_MARKER)).toBe("noop");
  });
});

// ---------------------------------------------------------------------------
// SPEC-014: requirement-to-spec catalog entry
// ---------------------------------------------------------------------------

describe("SPEC-014: requirement-to-spec catalog entry", () => {
  it("TAC-08: is registered in the catalog with the correct path, marker and reusable workflow path", () => {
    const entry = findWorkflowTemplate("requirement-to-spec");
    expect(entry).toBeDefined();
    expect(entry!.targetPath).toBe(REQUIREMENT_TO_SPEC_REFERENCE_PATH);
    expect(entry!.marker).toBe(REQUIREMENT_TO_SPEC_REFERENCE_MARKER);
    expect(entry!.reusableWorkflowRepoPath).toBe(".github/workflows/requirement-to-spec.yml");
    expect(entry!.defaultRef).toBe(DEFAULT_REQUIREMENT_TO_SPEC_WORKFLOW_REF);
  });

  it("is a valid installable template", () => {
    expect(() => resolveWorkflowInstallPlan({ installWorkflows: "requirement-to-spec" })).not.toThrow();
    expect(resolveWorkflowInstallPlan({ installWorkflows: "requirement-to-spec" })).toEqual(["requirement-to-spec"]);
  });

  it("renders a minimal reference with default options", () => {
    const rendered = renderRequirementToSpecReference();
    expect(rendered).toContain(REQUIREMENT_TO_SPEC_REFERENCE_MARKER);
    expect(rendered).toContain("push:");
    expect(rendered).toContain("docs/requirements/**/*.md");
    expect(rendered).toContain(`requirement-to-spec.yml@${DEFAULT_REQUIREMENT_TO_SPEC_WORKFLOW_REF}`);
    expect(rendered).toContain(`harness-ref: '${DEFAULT_REQUIREMENT_TO_SPEC_WORKFLOW_REF}'`);
    expect(rendered).toContain("provider: 'github-copilot'");
  });

  it("renders a reference with claude-code provider", () => {
    const rendered = renderRequirementToSpecReference({ provider: "claude-code", harnessRef: "v1.0.0" });
    expect(rendered).toContain("provider: 'claude-code'");
    expect(rendered).toContain("requirement-to-spec.yml@v1.0.0");
    expect(rendered).toContain("harness-ref: 'v1.0.0'");
  });

  it("renders with configurable requirement-path-glob and default-branch", () => {
    const rendered = renderRequirementToSpecReference({
      requirementPathGlob: "requirements/**/*.md",
      defaultBranch: "trunk",
    });
    expect(rendered).toContain("requirements/**/*.md");
    expect(rendered).toContain("branches: [trunk]");
  });

  it("minimal permissions: only contents:read and issues:write (no secrets:inherit)", () => {
    const rendered = renderRequirementToSpecReference();
    expect(rendered).toContain("contents: read");
    expect(rendered).toContain("issues: write");
    expect(rendered).not.toContain("secrets: inherit");
    expect(rendered).not.toContain("contents: write");
  });

  it("uses non-cancelling concurrency to avoid dropping queued runs", () => {
    const rendered = renderRequirementToSpecReference();
    expect(rendered).toContain("cancel-in-progress: false");
  });

  it("rendered reference is parseable by decideWorkflowInstall", () => {
    const rendered = renderRequirementToSpecReference();
    expect(decideWorkflowInstall(undefined, rendered, REQUIREMENT_TO_SPEC_REFERENCE_MARKER)).toBe("create");
    expect(decideWorkflowInstall(rendered, rendered, REQUIREMENT_TO_SPEC_REFERENCE_MARKER)).toBe("noop");
  });

  it("catalog entry renderReference() matches renderRequirementToSpecReference() for identical params", () => {
    const entry = findWorkflowTemplate("requirement-to-spec")!;
    const options = { harnessRef: "v1.2.3", provider: "claude-code" };
    expect(entry.renderReference(options)).toBe(renderRequirementToSpecReference(options));
  });
});
