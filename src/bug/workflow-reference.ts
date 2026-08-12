import { decideWorkflowInstall, type WorkflowInstallDecision } from "../workflows/install-decision.js";
export type { WorkflowInstallDecision } from "../workflows/install-decision.js";

export const BUG_WORKFLOW_REFERENCE_PATH = ".github/workflows/harness-bug-triage.yml";
export const BUG_WORKFLOW_REFERENCE_MARKER = "# Managed by pi-spec-harness: bug-workflow-reference v1";
export const DEFAULT_BUG_TRIAGE_WORKFLOW_REF = "v0.1.0";

export interface BugWorkflowReferenceOptions {
  harnessRef?: string;
  reusableRepository?: string;
  claudeCodeActionVersion?: string;
  previewVerifyCommand?: string;
  reviewer?: string;
}

export function renderBugWorkflowReference(options: BugWorkflowReferenceOptions = {}): string {
  const harnessRef = options.harnessRef ?? DEFAULT_BUG_TRIAGE_WORKFLOW_REF;
  const reusableRepository = options.reusableRepository ?? "munichdeveloper/pi-spec-harness";
  const claudeCodeActionVersion = options.claudeCodeActionVersion ?? "${{ vars.HARNESS_CLAUDE_CODE_ACTION_VERSION || 'v1.0.94' }}";
  const reviewer = options.reviewer ?? "${{ vars.HARNESS_BUG_REVIEWER || '' }}";
  const previewVerifyCommand = options.previewVerifyCommand ?? "${{ vars.HARNESS_BUG_PREVIEW_VERIFY_COMMAND || '' }}";
  const issueNumber = "${{ github.event.issue.number }}";
  const issueTypeName = "${{ github.event.issue.type.name || '' }}";
  const issueLabelsJson = "${{ toJson(github.event.issue.labels.*.name) }}";
  const issueAuthor = "${{ github.event.issue.user.login }}";

  return `${BUG_WORKFLOW_REFERENCE_MARKER}
name: Harness Bug Triage

on:
  issues:
    types: [opened, typed, labeled]

concurrency:
  group: harness-bug-triage-\${{ github.repository }}-\${{ github.event.issue.number }}
  cancel-in-progress: false

jobs:
  triage:
    if: >-
      github.event_name == 'issues' &&
      ((github.event.action == 'opened' &&
        (github.event.issue.type.name == 'Bug' || contains(github.event.issue.labels.*.name, 'type:bug'))) ||
       (github.event.action == 'typed' && github.event.issue.type.name == 'Bug') ||
       (github.event.action == 'labeled' && github.event.label.name == 'type:bug'))
    uses: ${reusableRepository}/.github/workflows/bug-triage.yml@${harnessRef}
    with:
      issue-number: ${issueNumber}
      issue-type-name: ${issueTypeName}
      issue-labels-json: ${issueLabelsJson}
      issue-author: ${issueAuthor}
      reviewer: ${reviewer}
      claude-code-action-version: ${claudeCodeActionVersion}
      preview-verify-command: ${previewVerifyCommand}
    secrets: inherit
`;
}

/**
 * Thin, bug-specific wrapper kept for backwards compatibility (SPEC-006
 * TAC-02/TAC-08). The actual decision logic now lives in the generic
 * `decideWorkflowInstall()` in `src/workflows/install-decision.ts`, which
 * every catalog entry (including this one) uses uniformly.
 */
export function decideBugWorkflowInstall(existingContent: string | undefined, expectedContent: string): WorkflowInstallDecision {
  return decideWorkflowInstall(existingContent, expectedContent, BUG_WORKFLOW_REFERENCE_MARKER);
}
