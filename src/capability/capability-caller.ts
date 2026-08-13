import { decideWorkflowInstall, type WorkflowInstallDecision } from "../workflows/install-decision.js";

export const CAPABILITY_CALLER_PATH = ".github/workflows/harness-capability-smoke.yml";
export const CAPABILITY_CALLER_MARKER = "# Managed by pi-spec-harness: capability-smoke-reference v1";
export const DEFAULT_CAPABILITY_SMOKE_WORKFLOW_REF = "v0.2.2";

export interface CapabilityCallerOptions {
  harnessRef?: string;
  reusableRepository?: string;
  claudeCodeActionVersion?: string;
  watchedPaths?: string[];
}

/**
 * Renders the thin capability-smoke caller installed into target repositories
 * via `harness init --install-workflows capability-smoke` (SPEC-010 TAC-09/TAC-12).
 *
 * Triggers:
 * - `push` on changes to the watched paths (default: this file and the
 *   referenced bug-triage caller, plus the harness-capability-smoke file
 *   itself) so the attestation is refreshed when permissions change
 * - `workflow_dispatch` for manual re-runs
 * - `workflow_call` so the Bug Pipeline can invoke it directly (TAC-07/TAC-09)
 */
export function renderCapabilityCallerReference(options: CapabilityCallerOptions = {}): string {
  const harnessRef = options.harnessRef ?? DEFAULT_CAPABILITY_SMOKE_WORKFLOW_REF;
  const reusableRepository = options.reusableRepository ?? "munichdeveloper/pi-spec-harness";
  const claudeCodeActionVersion =
    options.claudeCodeActionVersion ?? "${{ vars.HARNESS_CLAUDE_CODE_ACTION_VERSION || 'v1.0.94' }}";
  const watchedPaths = options.watchedPaths ?? [
    ".github/workflows/harness-capability-smoke.yml",
    ".github/workflows/harness-bug-triage.yml",
  ];
  const pathsYaml = watchedPaths.map((p) => `      - '${p}'`).join("\n");

  return `${CAPABILITY_CALLER_MARKER}
name: Harness Capability Smoke

on:
  push:
    paths:
${pathsYaml}
  workflow_dispatch:
  workflow_call:
    inputs:
      claude-code-action-version:
        description: Pinned claude-code-action version.
        required: false
        type: string
        default: v1.0.94

permissions:
  contents: read
  actions: read

concurrency:
  group: harness-capability-smoke-\${{ github.repository }}-\${{ inputs.claude-code-action-version || vars.HARNESS_CLAUDE_CODE_ACTION_VERSION || 'v1.0.94' }}
  cancel-in-progress: false

jobs:
  smoke:
    uses: ${reusableRepository}/.github/workflows/capability-smoke.yml@${harnessRef}
    with:
      claude-code-action-version: ${claudeCodeActionVersion}
    secrets: inherit
`;
}

/**
 * Thin wrapper kept for symmetry with other install helpers.
 */
export function decideCapabilityCallerInstall(
  existingContent: string | undefined,
  expectedContent: string,
): WorkflowInstallDecision {
  return decideWorkflowInstall(existingContent, expectedContent, CAPABILITY_CALLER_MARKER);
}
