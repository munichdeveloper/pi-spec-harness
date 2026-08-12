import {
  BUG_WORKFLOW_REFERENCE_MARKER,
  BUG_WORKFLOW_REFERENCE_PATH,
  DEFAULT_BUG_TRIAGE_WORKFLOW_REF,
  renderBugWorkflowReference,
  type BugWorkflowReferenceOptions,
} from "../bug/workflow-reference.js";

export type { WorkflowInstallDecision } from "./install-decision.js";
export { decideWorkflowInstall } from "./install-decision.js";

const DEFAULT_REUSABLE_WORKFLOW_REPOSITORY = "munichdeveloper/pi-spec-harness";

export const SPEC_TO_ISSUE_REFERENCE_PATH = ".github/workflows/harness-spec-to-issue.yml";
export const SPEC_TO_ISSUE_REFERENCE_MARKER = "# Managed by pi-spec-harness: spec-to-issue-reference v1";
export const DEFAULT_SPEC_TO_ISSUE_WORKFLOW_REF = "v0.1.1";

export interface SpecToIssueReferenceOptions {
  harnessRef?: string;
  reusableRepository?: string;
  specPathGlob?: string;
  defaultBranch?: string;
}

export function renderSpecToIssueReference(options: SpecToIssueReferenceOptions = {}): string {
  const harnessRef = options.harnessRef ?? DEFAULT_SPEC_TO_ISSUE_WORKFLOW_REF;
  const reusableRepository = options.reusableRepository ?? DEFAULT_REUSABLE_WORKFLOW_REPOSITORY;
  const specPathGlob = options.specPathGlob ?? "docs/specifications/**/*.md";
  const defaultBranch = options.defaultBranch ?? "main";

  return `${SPEC_TO_ISSUE_REFERENCE_MARKER}
name: Harness Spec to Issue

on:
  push:
    branches: [${defaultBranch}]
    paths:
      - '${specPathGlob}'

jobs:
  spec-to-issue:
    uses: ${reusableRepository}/.github/workflows/spec-to-issue.yml@${harnessRef}
    with:
      spec-path-glob: '${specPathGlob}'
      default-branch: '${defaultBranch}'
      harness-ref: '${harnessRef}'
`;
}

export const LABEL_APPROVAL_BUNDLING_REFERENCE_PATH = ".github/workflows/harness-label-approval-bundling.yml";
export const LABEL_APPROVAL_BUNDLING_REFERENCE_MARKER = "# Managed by pi-spec-harness: label-approval-bundling-reference v1";
export const DEFAULT_LABEL_APPROVAL_BUNDLING_WORKFLOW_REF = "v0.1.1";

export interface LabelApprovalBundlingReferenceOptions {
  harnessRef?: string;
  reusableRepository?: string;
  triggerLabel?: string;
  targetLabels?: string[];
}

export function renderLabelApprovalBundlingReference(options: LabelApprovalBundlingReferenceOptions = {}): string {
  const harnessRef = options.harnessRef ?? DEFAULT_LABEL_APPROVAL_BUNDLING_WORKFLOW_REF;
  const reusableRepository = options.reusableRepository ?? DEFAULT_REUSABLE_WORKFLOW_REPOSITORY;
  const triggerLabel = options.triggerLabel ?? "harness:approved-for-agent";
  const targetLabels = options.targetLabels ?? ["status:ready", "ai:allowed", "harness:implementation"];
  const targetLabelsJson = JSON.stringify(targetLabels);

  return `${LABEL_APPROVAL_BUNDLING_REFERENCE_MARKER}
name: Harness Label Approval Bundling

on:
  issues:
    types: [labeled]

jobs:
  bundle:
    if: github.event.label.name == '${triggerLabel}'
    uses: ${reusableRepository}/.github/workflows/label-approval-bundling.yml@${harnessRef}
    with:
      trigger-label: '${triggerLabel}'
      target-labels: '${targetLabelsJson}'
      harness-ref: '${harnessRef}'
`;
}

export interface WorkflowTemplateDefinition {
  name: string;
  targetPath: string;
  marker: string;
  reusableWorkflowRepoPath: string;
  defaultRef: string;
  renderReference(options?: Record<string, unknown>): string;
}

// ---------------------------------------------------------------------------
// SPEC-009: Review-fix reference workflow template
// ---------------------------------------------------------------------------

export const REVIEW_FIX_REFERENCE_PATH = ".github/workflows/harness-review-fix.yml";
export const REVIEW_FIX_REFERENCE_MARKER = "# Managed by pi-spec-harness: review-fix-reference v1";
export const DEFAULT_REVIEW_FIX_WORKFLOW_REF = "v0.1.1";

export interface ReviewFixReferenceOptions {
  harnessRef?: string;
  reusableRepository?: string;
  trustedActors?: string[];
  fixAgent?: string;
}

export function renderReviewFixReference(options: ReviewFixReferenceOptions = {}): string {
  const harnessRef = options.harnessRef ?? DEFAULT_REVIEW_FIX_WORKFLOW_REF;
  const reusableRepository = options.reusableRepository ?? DEFAULT_REUSABLE_WORKFLOW_REPOSITORY;
  const trustedActors = options.trustedActors ?? ["copilot-pull-request-reviewer"];
  const fixAgent = options.fixAgent ?? "github-copilot";

  return `${REVIEW_FIX_REFERENCE_MARKER}
name: Harness Review Fix

on:
  pull_request_review:
    types: [submitted]
  pull_request_review_thread:
    types: [resolved, unresolved]

# SPEC-009 decision 1: one concurrent review-fix job per PR.
concurrency:
  group: harness-review-fix-\${{ github.repository }}-\${{ github.event.pull_request.number }}
  cancel-in-progress: false

permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  review-fix:
    uses: ${reusableRepository}/.github/workflows/review-fix.yml@${harnessRef}
    with:
      harness-ref: '${harnessRef}'
      pull-request: \${{ github.event.pull_request.number }}
      review-id: \${{ github.event.review.id || 0 }}
      reviewed-head-sha: \${{ github.event.review.commit_id || github.event.pull_request.head.sha }}
      reviewer: \${{ github.event.review.user.login || '' }}
      reviewer-type: \${{ github.event.review.user.type || '' }}
      review-state: \${{ github.event.review.state || '' }}
      submitted-at: \${{ github.event.review.submitted_at || '' }}
      trusted-actors: '${trustedActors.join(",")}'
      fix-agent: '${fixAgent}'
`;
}

export const WORKFLOW_TEMPLATE_CATALOG: WorkflowTemplateDefinition[] = [
  {
    name: "bug-triage",
    targetPath: BUG_WORKFLOW_REFERENCE_PATH,
    marker: BUG_WORKFLOW_REFERENCE_MARKER,
    reusableWorkflowRepoPath: ".github/workflows/bug-triage.yml",
    defaultRef: DEFAULT_BUG_TRIAGE_WORKFLOW_REF,
    renderReference: (options) => renderBugWorkflowReference(options as BugWorkflowReferenceOptions | undefined),
  },
  {
    name: "spec-to-issue",
    targetPath: SPEC_TO_ISSUE_REFERENCE_PATH,
    marker: SPEC_TO_ISSUE_REFERENCE_MARKER,
    reusableWorkflowRepoPath: ".github/workflows/spec-to-issue.yml",
    defaultRef: DEFAULT_SPEC_TO_ISSUE_WORKFLOW_REF,
    renderReference: (options) => renderSpecToIssueReference(options as SpecToIssueReferenceOptions | undefined),
  },
  {
    name: "label-approval-bundling",
    targetPath: LABEL_APPROVAL_BUNDLING_REFERENCE_PATH,
    marker: LABEL_APPROVAL_BUNDLING_REFERENCE_MARKER,
    reusableWorkflowRepoPath: ".github/workflows/label-approval-bundling.yml",
    defaultRef: DEFAULT_LABEL_APPROVAL_BUNDLING_WORKFLOW_REF,
    renderReference: (options) => renderLabelApprovalBundlingReference(options as LabelApprovalBundlingReferenceOptions | undefined),
  },
  {
    name: "review-fix",
    targetPath: REVIEW_FIX_REFERENCE_PATH,
    marker: REVIEW_FIX_REFERENCE_MARKER,
    reusableWorkflowRepoPath: ".github/workflows/review-fix.yml",
    defaultRef: DEFAULT_REVIEW_FIX_WORKFLOW_REF,
    renderReference: (options) => renderReviewFixReference(options as ReviewFixReferenceOptions | undefined),
  },
];

export function findWorkflowTemplate(name: string): WorkflowTemplateDefinition | undefined {
  return WORKFLOW_TEMPLATE_CATALOG.find((entry) => entry.name === name);
}

/**
 * Pure planning helper used by `cmdInit` (SPEC-006 TAC-04/TAC-07):
 * - Validates every name requested via `--install-workflows` against the
 *   catalog and throws (before any file is written) if any is unknown.
 * - Combines it with the legacy `--install-bug-workflow` flag into a
 *   single, de-duplicated set of catalog names, so requesting the same
 *   entry through both flags never results in two write actions.
 */
export function resolveWorkflowInstallPlan(options: { installBugWorkflow?: boolean; installWorkflows?: string }): string[] {
  const requested = [...new Set(
    (options.installWorkflows ?? "")
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n.length > 0),
  )];

  for (const name of requested) {
    if (!findWorkflowTemplate(name)) {
      throw new Error(
        `unknown workflow template '${name}'; known templates: ${WORKFLOW_TEMPLATE_CATALOG.map((t) => t.name).join(", ")}`,
      );
    }
  }

  if (options.installBugWorkflow) {
    return [...new Set(["bug-triage", ...requested])];
  }
  return requested;
}
