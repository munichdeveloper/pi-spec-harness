import {
  BUG_WORKFLOW_REFERENCE_MARKER,
  BUG_WORKFLOW_REFERENCE_PATH,
  DEFAULT_BUG_TRIAGE_WORKFLOW_REF,
  renderBugWorkflowReference,
  type BugWorkflowReferenceOptions,
} from "../bug/workflow-reference.js";
import type { SpecGenerationProvider } from "../state/types.js";
import {
  CAPABILITY_CALLER_MARKER,
  CAPABILITY_CALLER_PATH,
  DEFAULT_CAPABILITY_SMOKE_WORKFLOW_REF,
  renderCapabilityCallerReference,
  type CapabilityCallerOptions,
} from "../capability/capability-caller.js";

export type { WorkflowInstallDecision } from "./install-decision.js";
export { decideWorkflowInstall } from "./install-decision.js";

export const DEFAULT_REUSABLE_WORKFLOW_REPOSITORY = "munichdeveloper/pi-spec-harness";

export const SPEC_TO_ISSUE_REFERENCE_PATH = ".github/workflows/harness-spec-to-issue.yml";
export const SPEC_TO_ISSUE_REFERENCE_MARKER = "# Managed by pi-spec-harness: spec-to-issue-reference v1";
export const DEFAULT_SPEC_TO_ISSUE_WORKFLOW_REF = "v0.2.2";

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

permissions:
  contents: read
  issues: write

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
export const DEFAULT_LABEL_APPROVAL_BUNDLING_WORKFLOW_REF = "v0.2.4";

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

permissions:
  contents: read
  issues: write

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
export const DEFAULT_REVIEW_FIX_WORKFLOW_REF = "v0.2.4";

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
  issue_comment:
    types: [created, edited]
  pull_request_target:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  issues: write
  pull-requests: write
  checks: write

jobs:
  review-fix-review:
    if: \${{ github.event_name == 'pull_request_review' }}
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
  resolve-review-fix-comment:
    if: \${{ github.event_name == 'issue_comment' && github.event.issue.pull_request }}
    runs-on: ubuntu-latest
    outputs:
      head_sha: \${{ steps.pr.outputs.head_sha }}
    steps:
      - id: pr
        env:
          GH_TOKEN: \${{ github.token }}
          REPOSITORY: \${{ github.repository }}
          PULL_REQUEST_NUMBER: \${{ github.event.issue.number }}
        run: |
          head_sha="$(gh api "repos/$REPOSITORY/pulls/$PULL_REQUEST_NUMBER" --jq '.head.sha')"
          echo "head_sha=$head_sha" >> "$GITHUB_OUTPUT"
  review-fix-comment:
    needs: resolve-review-fix-comment
    if: \${{ github.event_name == 'issue_comment' && github.event.issue.pull_request && needs.resolve-review-fix-comment.outputs.head_sha != '' }}
    uses: ${reusableRepository}/.github/workflows/review-fix.yml@${harnessRef}
    with:
      harness-ref: '${harnessRef}'
      pull-request: \${{ github.event.issue.number }}
      review-id: 0
      reviewed-head-sha: \${{ needs.resolve-review-fix-comment.outputs.head_sha }}
      reviewer: \${{ github.event.comment.user.login || '' }}
      reviewer-type: \${{ github.event.comment.user.type || '' }}
      review-state: commented
      submitted-at: \${{ github.event.comment.updated_at || github.event.comment.created_at || '' }}
      trusted-actors: '${trustedActors.join(",")}'
      fix-agent: '${fixAgent}'
  review-fix-pr-event:
    if: \${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name == github.repository }}
    uses: ${reusableRepository}/.github/workflows/review-fix.yml@${harnessRef}
    with:
      harness-ref: '${harnessRef}'
      pull-request: \${{ github.event.pull_request.number }}
      review-id: 0
      # Metadata only for binding/reconciliation. The reusable workflow must
      # continue to checkout only the pinned harness ref, never this PR head.
      reviewed-head-sha: \${{ github.event.pull_request.head.sha || '' }}
      reviewer: ''
      reviewer-type: ''
      review-state: ''
      submitted-at: \${{ github.event.pull_request.updated_at || github.event.pull_request.created_at || '' }}
      trusted-actors: '${trustedActors.join(",")}'
      fix-agent: '${fixAgent}'
`;
}

// ---------------------------------------------------------------------------
// SPEC-005: Process audit receiver reference workflow template
// ---------------------------------------------------------------------------

export const PROCESS_AUDIT_RECEIVER_PATH = ".github/workflows/harness-process-audit-receiver.yml";
export const PROCESS_AUDIT_RECEIVER_MARKER = "# Managed by pi-spec-harness: process-audit-receiver-reference v1";
export const DEFAULT_PROCESS_AUDIT_RECEIVER_WORKFLOW_REF = "v0.2.4";

export interface ProcessAuditReceiverOptions {
  harnessRef?: string;
  reusableRepository?: string;
  journalDir?: string;
}

/**
 * Render the installable thin receiver for target repositories.
 *
 * The generated file calls `process-audit-automation.yml` as a remote reusable
 * workflow in the harness repository at the configured immutable ref.  It never
 * uses the local path `./.github/workflows/process-audit-automation.yml` because
 * target repos do not have that file; the reusable logic lives in the harness.
 */
export function renderProcessAuditReceiver(options: ProcessAuditReceiverOptions = {}): string {
  const harnessRef = options.harnessRef ?? DEFAULT_PROCESS_AUDIT_RECEIVER_WORKFLOW_REF;
  const reusableRepository = options.reusableRepository ?? DEFAULT_REUSABLE_WORKFLOW_REPOSITORY;
  const journalDir = options.journalDir ?? "docs/process-audit/journal";

  return `${PROCESS_AUDIT_RECEIVER_MARKER}
name: Harness Process Audit Receiver

# SPEC-005 process_audit receiver.
#
# Receives \`repository_dispatch\` events of type \`process_audit\` and
# delegates to the reusable process-audit-automation workflow in the harness
# repository for validated, idempotent, conflict-safe journal recording.
#
# Generated by pi-spec-harness \`harness install process-audit-receiver\`.
# Do not edit this file manually — re-run the install command to update.

on:
  repository_dispatch:
    types: [process_audit]

permissions:
  contents: write

jobs:
  record:
    uses: ${reusableRepository}/.github/workflows/process-audit-automation.yml@${harnessRef}
    with:
      audit-payload-json: \${{ toJson(github.event.client_payload.audit) }}
      journal-dir: '${journalDir}'
      harness-ref: '${harnessRef}'
    permissions:
      contents: write
`;
}

// ---------------------------------------------------------------------------
// SPEC-012: Run documentation finalizer reference workflow template
// ---------------------------------------------------------------------------

export const RUN_DOCUMENTATION_FINALIZER_PATH = ".github/workflows/harness-run-documentation-finalizer.yml";
export const RUN_DOCUMENTATION_FINALIZER_MARKER = "# Managed by pi-spec-harness: run-documentation-finalizer-reference v1";
export const DEFAULT_RUN_DOCUMENTATION_FINALIZER_WORKFLOW_REF = "v0.2.4";

export interface RunDocumentationFinalizerOptions {
  harnessRef?: string;
  reusableRepository?: string;
  defaultBranch?: string;
  generatedDirectory?: string;
  indexPath?: string;
  obsidianBasePath?: string;
  /** Legacy directories to scan for existing run documents. Each entry is passed as a separate --legacy-directory argument. */
  legacyDirectories?: string[];
}

export function renderRunDocumentationFinalizer(options: RunDocumentationFinalizerOptions = {}): string {
  const harnessRef = options.harnessRef ?? DEFAULT_RUN_DOCUMENTATION_FINALIZER_WORKFLOW_REF;
  const reusableRepository = options.reusableRepository ?? DEFAULT_REUSABLE_WORKFLOW_REPOSITORY;
  const defaultBranch = options.defaultBranch ?? "main";
  const generatedDirectory = options.generatedDirectory ?? "docs/runs/generated";
  const indexPath = options.indexPath ?? "docs/runs/RUN-INDEX.md";
  const obsidianBasePath = options.obsidianBasePath ?? "docs/runs/Runs.base";
  // Build legacy-directories as a JSON array string so the reusable workflow
  // can parse, validate, and pass each entry safely via a Bash array.
  const legacyDirsJson =
    options.legacyDirectories && options.legacyDirectories.length > 0
      ? JSON.stringify(options.legacyDirectories)
      : "";

  return `${RUN_DOCUMENTATION_FINALIZER_MARKER}
name: Harness Run Documentation Finalizer

on:
  workflow_dispatch:
    inputs:
      issue-number:
        description: Tracking issue number selected by trusted reconciliation
        required: true
        type: string
  issues:
    types: [labeled]
# Non-cancelling concurrency: a waiting run must not be dropped.
# TAC-16: cancel-in-progress must be false.
concurrency:
  group: harness-run-documentation-finalizer-\${{ github.repository }}-\${{ inputs.issue-number || github.event.issue.number }}
  cancel-in-progress: false

# TAC-16: minimal permissions only; no secrets: inherit.
permissions:
  contents: write
  issues: write
  pull-requests: read
  actions: read

jobs:
  finalize:
    uses: ${reusableRepository}/.github/workflows/run-documentation-finalizer.yml@${harnessRef}
    with:
      harness-ref: '${harnessRef}'
      default-branch: '${defaultBranch}'
      generated-directory: '${generatedDirectory}'
      index-path: '${indexPath}'
      obsidian-base-path: '${obsidianBasePath}'${legacyDirsJson.length > 0 ? `\n      legacy-directories: '${legacyDirsJson}'` : ""}
      issue-number: \${{ inputs.issue-number || github.event.issue.number }}
`;
}

// ---------------------------------------------------------------------------
// SPEC-014: Requirement-to-Spec agent pipeline reference workflow template
// ---------------------------------------------------------------------------

export const REQUIREMENT_TO_SPEC_REFERENCE_PATH = ".github/workflows/harness-requirement-to-spec.yml";
export const REQUIREMENT_TO_SPEC_REFERENCE_MARKER = "# Managed by pi-spec-harness: requirement-to-spec-reference v1";
export const DEFAULT_REQUIREMENT_TO_SPEC_WORKFLOW_REF = "v0.3.0";

export interface RequirementToSpecReferenceOptions {
  harnessRef?: string;
  reusableRepository?: string;
  requirementPathGlob?: string;
  defaultBranch?: string;
  /** Agent provider. Defaults to "github-copilot". */
  provider?: SpecGenerationProvider;
}

/**
 * Render the installable thin receiver that observes merged requirement files
 * and dispatches the spec-generation agent. Runs only on the default branch;
 * the reusable workflow in the harness repository performs the actual dispatch.
 * No write-capable credentials are used on the PR head. SPEC-014, decision 6.
 */
export function renderRequirementToSpecReference(options: RequirementToSpecReferenceOptions = {}): string {
  const harnessRef = options.harnessRef ?? DEFAULT_REQUIREMENT_TO_SPEC_WORKFLOW_REF;
  const reusableRepository = options.reusableRepository ?? DEFAULT_REUSABLE_WORKFLOW_REPOSITORY;
  const requirementPathGlob = options.requirementPathGlob ?? "docs/requirements/**/*.md";
  const defaultBranch = options.defaultBranch ?? "main";
  const provider = options.provider ?? "github-copilot";

  return `${REQUIREMENT_TO_SPEC_REFERENCE_MARKER}
name: Harness Requirement to Spec

# SPEC-014: Observes merged requirement files on the default branch and
# dispatches the configured spec-generation agent.  The reusable workflow
# validates the requirement frontmatter, computes the stable dispatch key
# <repository>:<req-id>:<source-sha>, and creates exactly one spec PR per key.
#
# Generated by pi-spec-harness \`harness install requirement-to-spec\`.
# Do not edit this file manually — re-run the install command to update.

on:
  push:
    branches: [${defaultBranch}]
    paths:
      - '${requirementPathGlob}'
  pull_request_target:
    types: [opened, synchronize, reopened, closed]
  schedule:
    - cron: '17,47 * * * *'
  workflow_dispatch:

# Non-cancelling: a queued run must not be dropped when a second push arrives.
# Serialized per repository so concurrent pushes cannot race into duplicate
# outbox reads and duplicate spec dispatches.
concurrency:
  group: harness-requirement-to-spec-\${{ github.repository }}
  cancel-in-progress: false

# Minimal permissions: read-only on contents; issues for gate reporting.
# No write-capable credentials are passed to PR-head code.
permissions:
  contents: read
  issues: write
  pull-requests: read

jobs:
  requirement-to-spec:
    uses: ${reusableRepository}/.github/workflows/requirement-to-spec.yml@${harnessRef}
    with:
      harness-ref: '${harnessRef}'
      requirement-path-glob: '${requirementPathGlob}'
      default-branch: '${defaultBranch}'
      provider: '${provider}'
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
  // SPEC-010: capability-smoke caller
  {
    name: "capability-smoke",
    targetPath: CAPABILITY_CALLER_PATH,
    marker: CAPABILITY_CALLER_MARKER,
    reusableWorkflowRepoPath: ".github/workflows/capability-smoke.yml",
    defaultRef: DEFAULT_CAPABILITY_SMOKE_WORKFLOW_REF,
    renderReference: (options) => renderCapabilityCallerReference(options as CapabilityCallerOptions | undefined),
  },
  // SPEC-012: run documentation finalizer
  {
    name: "run-documentation-finalizer",
    targetPath: RUN_DOCUMENTATION_FINALIZER_PATH,
    marker: RUN_DOCUMENTATION_FINALIZER_MARKER,
    reusableWorkflowRepoPath: ".github/workflows/run-documentation-finalizer.yml",
    defaultRef: DEFAULT_RUN_DOCUMENTATION_FINALIZER_WORKFLOW_REF,
    renderReference: (options) => renderRunDocumentationFinalizer(options as RunDocumentationFinalizerOptions | undefined),
  },
  // SPEC-005: process-audit receiver (thin receiver calling remote reusable workflow)
  {
    name: "process-audit-receiver",
    targetPath: PROCESS_AUDIT_RECEIVER_PATH,
    marker: PROCESS_AUDIT_RECEIVER_MARKER,
    reusableWorkflowRepoPath: ".github/workflows/process-audit-automation.yml",
    defaultRef: DEFAULT_PROCESS_AUDIT_RECEIVER_WORKFLOW_REF,
    renderReference: (options) => renderProcessAuditReceiver(options as ProcessAuditReceiverOptions | undefined),
  },
  // SPEC-014: requirement-to-spec agent pipeline
  {
    name: "requirement-to-spec",
    targetPath: REQUIREMENT_TO_SPEC_REFERENCE_PATH,
    marker: REQUIREMENT_TO_SPEC_REFERENCE_MARKER,
    reusableWorkflowRepoPath: ".github/workflows/requirement-to-spec.yml",
    defaultRef: DEFAULT_REQUIREMENT_TO_SPEC_WORKFLOW_REF,
    renderReference: (options) => renderRequirementToSpecReference(options as RequirementToSpecReferenceOptions | undefined),
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
