import { decideWorkflowInstall, type WorkflowInstallDecision } from "../workflows/install-decision.js";
import { DEFAULT_HARNESS_WORKFLOW_REF } from "../release.js";

export const CAPABILITY_CALLER_PATH = ".github/workflows/harness-capability-smoke.yml";
export const CAPABILITY_CALLER_MARKER = "# Managed by pi-spec-harness: capability-smoke-reference v1";
export const DEFAULT_CAPABILITY_SMOKE_WORKFLOW_REF = DEFAULT_HARNESS_WORKFLOW_REF;

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
    options.claudeCodeActionVersion ?? "v1.0.94";
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
        description: >-
          Informational: the version tag or SHA the caller expects to be running.
          This value does NOT change the action version executed by the reusable
          workflow, which is hardcoded to its own pinned ref.
        required: false
        type: string
        default: v1.0.94

permissions:
  contents: read
  actions: write   # required for cache save/restore in the reusable workflow
  id-token: write  # required by the pinned Claude action in the reusable workflow

jobs:
  dispatch-after-default-branch-push:
    if: github.event_name == 'push' && github.ref_name == github.event.repository.default_branch
    runs-on: ubuntu-latest
    steps:
      - name: Start supported capability smoke event
        env:
          GH_TOKEN: \${{ github.token }}
        run: gh workflow run harness-capability-smoke.yml --ref "$GITHUB_REF_NAME"

  smoke:
    if: github.event_name != 'push'
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
