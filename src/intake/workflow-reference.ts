import { DEFAULT_HARNESS_WORKFLOW_REF } from "../release.js";

export const ISSUE_INTAKE_REFERENCE_PATH = ".github/workflows/harness-issue-intake.yml";
export const ISSUE_INTAKE_REFERENCE_MARKER = "# Managed by pi-spec-harness: issue-intake-reference v1";
export const DEFAULT_ISSUE_INTAKE_WORKFLOW_REF = DEFAULT_HARNESS_WORKFLOW_REF;

export interface IssueIntakeReferenceOptions {
  harnessRef?: string;
  reusableRepository?: string;
}

export function renderIssueIntakeReference(options: IssueIntakeReferenceOptions = {}): string {
  const harnessRef = options.harnessRef ?? DEFAULT_ISSUE_INTAKE_WORKFLOW_REF;
  const reusableRepository = options.reusableRepository ?? "munichdeveloper/pi-spec-harness";

  return `${ISSUE_INTAKE_REFERENCE_MARKER}
name: Harness Issue Intake

on:
  issues:
    types: [opened, edited]

concurrency:
  group: harness-issue-intake-\${{ github.repository }}-\${{ github.event.issue.number }}
  cancel-in-progress: false

permissions:
  contents: read
  issues: write

jobs:
  intake:
    uses: ${reusableRepository}/.github/workflows/issue-intake.yml@${harnessRef}
    with:
      issue-number: \${{ github.event.issue.number }}
      issue-title: \${{ github.event.issue.title }}
      issue-body: \${{ github.event.issue.body || '' }}
      harness-ref: '${harnessRef}'
`;
}
