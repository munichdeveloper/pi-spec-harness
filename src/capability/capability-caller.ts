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
    ".github/workflows/harness-requirement-to-spec.yml",
    ".github/workflows/harness-label-approval-bundling.yml",
    ".github/workflows/harness-review-fix.yml",
    ".github/workflows/harness-spec-to-issue.yml",
    ".github/workflows/harness-run-documentation-finalizer.yml",
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
  issues: read   # required for label-contract validation
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
        run: gh workflow run harness-capability-smoke.yml --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME"

  installation-preflight:
    if: github.event_name != 'push'
    runs-on: ubuntu-latest
    steps:
      - name: Verify configured coding-agent credentials
        shell: bash
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: |
          if [[ -z "$ANTHROPIC_API_KEY" && -z "$CLAUDE_CODE_OAUTH_TOKEN" ]]; then
            echo "::error::Installation is installed-but-not-ready: configure ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN for the selected coding agent. Secret values were not inspected or logged."
            exit 1
          fi

      - name: Verify installed agent workflow contracts
        shell: bash
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          set -euo pipefail
          repo="$GITHUB_REPOSITORY"
          default_branch="\${{ github.event.repository.default_branch }}"
          agent_workflows=(
            harness-bug-triage.yml
            harness-requirement-to-spec.yml
            harness-review-fix.yml
          )
          found=0
          for workflow in "\${agent_workflows[@]}"; do
            path=".github/workflows/$workflow"
            encoded="$(gh api "repos/$repo/contents/$path?ref=$default_branch" --jq '.content' 2>/dev/null || true)"
            [[ -z "$encoded" ]] && continue
            found=$((found + 1))
            content="$(printf '%s' "$encoded" | base64 --decode)"
            if ! grep -Eq 'uses: munichdeveloper/pi-spec-harness/.github/workflows/[^@]+@[0-9a-f]{40}$' <<<"$content"; then
              echo "::error::$path is not pinned to an immutable 40-character harness commit."
              exit 1
            fi
            state="$(gh api "repos/$repo/actions/workflows/$workflow" --jq '.state')"
            if [[ "$state" != "active" ]]; then
              echo "::error::$path is installed but its GitHub Actions workflow state is '$state'."
              exit 1
            fi
            if [[ "$workflow" == "harness-bug-triage.yml" ]]; then
              required_permissions=('contents write' 'issues write' 'pull-requests write' 'id-token write')
              for permission_contract in "\${required_permissions[@]}"; do
                read -r scope access <<<"$permission_contract"
                if ! grep -Fq "$scope: $access" <<<"$content"; then
                  echo "::error::$path does not grant required caller permission '$scope: $access'."
                  exit 1
                fi
              done
            fi
          done
          if [[ "$found" -eq 0 ]]; then
            echo "::error::Installation is installed-but-not-ready: no supported agent workflow is installed."
            exit 1
          fi

      - name: Verify zero-knowledge approval label contract
        shell: bash
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          set -euo pipefail
          repo="$GITHUB_REPOSITORY"
          required=(harness:approved-for-agent status:ready ai:allowed harness:implementation harness:run)
          for label in "\${required[@]}"; do
            if ! gh api "repos/$repo/labels/$label" >/dev/null 2>&1; then
              echo "::error::Installation is installed-but-not-ready: required internal label '$label' is missing. Re-run harness installation."
              exit 1
            fi
          done

  smoke:
    if: github.event_name != 'push'
    needs: installation-preflight
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
