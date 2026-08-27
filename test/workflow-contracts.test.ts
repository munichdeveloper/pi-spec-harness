import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_HARNESS_WORKFLOW_REF } from "../src/release.js";

describe("GitHub workflow contracts", () => {
  it("calls the self run-documentation finalizer locally while pinning its implementation checkout", async () => {
    const workflow = await readFile(".github/workflows/harness-run-documentation-finalizer.yml", "utf8");

    expect(workflow).toContain("# Managed by pi-spec-harness: run-documentation-finalizer-reference v1");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("uses: ./.github/workflows/run-documentation-finalizer.yml");
    expect(workflow).not.toContain("uses: munichdeveloper/pi-spec-harness/.github/workflows/run-documentation-finalizer.yml@");
    expect(workflow).toContain(`harness-ref: '${DEFAULT_HARNESS_WORKFLOW_REF}'`);
    expect(workflow).not.toContain("concurrency:");
    expect(workflow).not.toContain("cancel-in-progress:");
    const reusable = await readFile(".github/workflows/run-documentation-finalizer.yml", "utf8");
    expect(reusable).toContain(
      "group: harness-run-documentation-finalizer-${{ github.repository }}-${{ inputs.issue-number || github.event.issue.number || github.event.pull_request.number }}",
    );
    expect(reusable).toContain("cancel-in-progress: false");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).not.toContain("github.event.pull_request.number");
  });

  it("resumes only the exact tracking issue that received a decision label", async () => {
    const workflow = await readFile(".github/workflows/harness-gate-trigger.yml", "utf8");

    expect(workflow).toContain("issues:");
    expect(workflow).toContain("harness:run");
    expect(workflow).toContain("GITHUB_EVENT_PATH");
    expect(workflow).toContain("try capture");
    expect(workflow).toContain("catch {}");
    expect(workflow).toContain('--run-id "${{ steps.run.outputs.run_id }}"');
    // TAC-04/TAC-12: after a gate decision the orchestrator (not a single advance) is called
    expect(workflow).toContain("npm run harness -- orchestrate");
    expect(workflow).not.toContain("sort -V");
    expect(workflow).not.toContain("tail -1");
    expect(workflow).not.toContain("git push");
  });

  it("resume job runs delivery-pr-merge-effect reconciliation before orchestration (approval-first path)", async () => {
    const workflow = await readFile(".github/workflows/harness-gate-trigger.yml", "utf8");
    const resumeJob = workflow.slice(workflow.indexOf("  resume:"), workflow.indexOf("\n  orchestrate-on-pr-event:"));

    expect(resumeJob).toContain("delivery-pr-merge-effect");
    expect(resumeJob.indexOf("delivery-pr-merge-effect")).toBeLessThan(resumeJob.indexOf("npm run harness -- orchestrate"));
    // Orchestrate is conditional on the next action from delivery-pr-merge-effect
    expect(resumeJob).toContain("advance-phase");
    expect(resumeJob).toContain(".result.nextAction.action");
  });

  it("binds implementation PRs on lifecycle events and orchestrates their close (TAC-12)", async () => {
    const workflow = await readFile(".github/workflows/harness-gate-trigger.yml", "utf8");
    const prJob = workflow.slice(workflow.indexOf("  orchestrate-on-pr-event:"), workflow.indexOf("\n  reconcile:"));
    const permissions = workflow.slice(workflow.indexOf("permissions:"), workflow.indexOf("\n# TAC-10"));

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("types: [opened, edited, synchronize, closed]");
    expect(workflow).toContain("impl-pr-auto-bind");
    expect(workflow).toContain('[A-Za-z0-9_-]+');
    expect(workflow).not.toContain('capture("harness:(?<id>[a-z0-9_-]+)")');
    expect(permissions).toContain("pull-requests: read");
    // Serialises across concurrent runs
    expect(workflow).toContain("cancel-in-progress: false");
    expect(prJob).toContain("delivery-pr-merge-effect");
    expect(prJob.indexOf("delivery-pr-merge-effect")).toBeLessThan(prJob.indexOf("npm run harness -- orchestrate"));
  });

  // TAC-09: workflow supports workflow_dispatch and push (own file on default branch)
  it("supports workflow_dispatch and push triggers for bootstrap reconciliation (TAC-09)", async () => {
    const workflow = await readFile(".github/workflows/harness-gate-trigger.yml", "utf8");

    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("harness-gate-trigger.yml");
  });

  it("sweeps approved delivery merges from trusted default-branch code", async () => {
    const workflow = await readFile(".github/workflows/harness-gate-trigger.yml", "utf8");
    const reconcileStart = workflow.indexOf("  reconcile:");
    const reviewFixStart = workflow.indexOf("\n  review-fix:");
    expect(reconcileStart).toBeGreaterThanOrEqual(0);
    expect(reviewFixStart).toBeGreaterThan(reconcileStart);
    const reconcileJob = workflow.slice(reconcileStart, reviewFixStart);

    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("*/10 * * * *");
    expect(reconcileJob).toContain("github.event_name == 'schedule'");
    expect(reconcileJob).toContain("npm run --silent harness -- reconcile");
    expect(reconcileJob).toContain("persist-run-documentation");
    expect(reconcileJob).toContain("gh workflow run");
    expect(reconcileJob).toContain("issue-number=$issue_number");
    expect(reconcileJob).toContain("DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}");
    expect(reconcileJob).toContain("actions: write");
    const topLevelPermissions = workflow.slice(workflow.indexOf("permissions:"), workflow.indexOf("\n# TAC-10"));
    expect(topLevelPermissions).not.toContain("actions: write");
    expect(reconcileJob).not.toContain("github.event.pull_request.head");
  });

  // TAC-10: repo-wide concurrency, no newest-issue selection
  it("serialises gate processing repo-wide and does not select by newest issue (TAC-10)", async () => {
    const workflow = await readFile(".github/workflows/harness-gate-trigger.yml", "utf8");

    // Repo-wide concurrency group -- not per-issue
    expect(workflow).toContain("github.repository");
    // The resume job only fires on the issues event, not all events
    expect(workflow).toContain("github.event_name");
    // reconcile command used for bootstrap
    expect(workflow).toContain("reconcile");
    // No "newest issue" selection patterns
    expect(workflow).not.toContain("sort -V");
    expect(workflow).not.toContain("tail -1");
  });

  it("exposes every structured decision-context field through gate-open", async () => {
    const cli = await readFile("src/cli.ts", "utf8");
    for (const option of ["scope", "criterion", "risk", "non-goal", "follow-up-action"]) {
      expect(cli).toContain(`.option("${option}"`);
    }
    expect(cli).toContain("decisionContext");
    expect(cli).toContain("prepareHumanGateIssue");
    expect(cli.indexOf("await store.save(state)")).toBeLessThan(cli.indexOf("publishHumanGateIssue(state, argv.gateId,"));
  });

  it("documents the target-repository merge transaction and check permissions", async () => {
    const [workflowDoc, skill, handover] = await Promise.all([
      readFile("docs/event-driven-workflow.md", "utf8"),
      readFile("skills/pi-spec-harness/SKILL.md", "utf8"),
      readFile("docs/HANDOVER.md", "utf8"),
    ]);
    const contract = [workflowDoc, skill, handover].join("\n");

    expect(contract).toContain("checks: read");
    expect(contract).toContain("statuses: read");
    expect(contract).toContain("Merge-Effekt");
    expect(contract).toContain("Reconcile");
    expect(contract).toContain("Tracking-Issue");
  });

  it("defines reusable bug-triage workflow contract with version gate and idempotency labels (TAC-01/TAC-05/TAC-08)", async () => {
    const workflow = await readFile(".github/workflows/bug-triage.yml", "utf8");

    expect(workflow).toContain("workflow_call");
    expect(workflow).toContain("claude-code-action-version");
    expect(workflow).toContain("preview-verify-command");
    // NOTE: a step's 'uses:' cannot reference the 'inputs' context in GitHub
    // Actions, so the actual pin is hardcoded; this asserts the hardcoded
    // pin matches the documented minimum version instead of the old
    // (invalid) templated form.
    expect(workflow).toContain("anthropics/claude-code-action@v1.0.94");
    expect(workflow).toContain(">=1.0.94");
    expect(workflow).toContain("bug-pipeline:in-progress");
    expect(workflow).toContain("bug-pipeline:started");
    expect(workflow).toContain("bug-pipeline:completed");
    expect(workflow).toContain("status:needs-human");
    expect(workflow).toContain("Post kickoff issue comment");
    expect(workflow).toContain("Add pipeline result comment");
    expect(workflow).toContain("closingIssuesReferences");
    expect(workflow).toContain("--limit 1000");
    expect(workflow).toContain("issue-number must be a positive integer");
    expect(workflow).not.toContain('--search "#${issue} in:body"');
    expect(workflow).toContain("Multiple open PRs close issue");
    expect(workflow).toContain("Mehrere offene PRs schließen dieses Issue");
    expect(workflow).toContain("steps.pr.outputs.matches");
    expect(workflow).not.toContain("head -n 1");
  });

  it("includes strict bug trigger filtering in the thin reference workflow template (TAC-02/TAC-04)", async () => {
    const cli = await readFile("src/cli.ts", "utf8");
    const helper = await readFile("src/bug/workflow-reference.ts", "utf8");

    expect(cli).toContain("install-bug-workflow");
    expect(cli).toContain("workflow conflict");
    expect(helper).toContain("types: [opened, typed, labeled]");
    expect(helper).toContain("github.event.action == 'opened'");
    expect(helper).toContain("contains(github.event.issue.labels.*.name, 'type:bug')");
    expect(helper).toContain("github.event.action == 'typed' && github.event.issue.type.name == 'Bug'");
    expect(helper).toContain("github.event.action == 'labeled' && github.event.label.name == 'type:bug'");
    expect(helper).toContain("cancel-in-progress: false");
    expect(helper).toContain("/.github/workflows/bug-triage.yml@");
  });

  it("defines the reusable spec-to-issue workflow contract with approved-status gating and broad idempotency search (SPEC-007 TAC-04/TAC-05/TAC-06/TAC-10)", async () => {
    const workflow = await readFile(".github/workflows/spec-to-issue.yml", "utf8");
    expect(workflow).toContain("workflow_call");
    expect(workflow).toContain("spec-path-glob");
    expect(workflow).toContain("spec-to-issue");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("if: github.ref_name == inputs.default-branch");
    expect(workflow).toContain('":(glob)$glob"');
    expect(workflow).not.toContain("contents: write");
  });

  it("defines the reusable label-approval-bundling workflow contract with single-action label bundling and automatic run bootstrap (SPEC-007 TAC-08/TAC-12/TAC-13/TAC-14)", async () => {
    const workflow = await readFile(".github/workflows/label-approval-bundling.yml", "utf8");
    expect(workflow).toContain("workflow_call");
    expect(workflow).toContain("trigger-label");
    expect(workflow).toContain("target-labels");
    expect(workflow).toContain("github.event.label.name == inputs.trigger-label");
    expect(workflow).toContain("gh issue edit");
    expect(workflow).toContain("harness init");
    expect(workflow).toContain("--stop-at-phase implementation");
    expect(workflow).toContain("agent-assign");
    expect(workflow).toContain("--branch '${{ github.event.repository.default_branch }}'");
    expect(workflow).toContain("issue-${{");
    expect(workflow).toContain("issues: write");
    expect(workflow).not.toContain("contents: write");
  });

  it("wires --install-workflows, --install-agents-context, spec-to-issue, and issue-create --from-spec-path in the CLI (SPEC-006/SPEC-007/SPEC-008)", async () => {
    const cli = await readFile("src/cli.ts", "utf8");
    expect(cli).toContain("install-workflows");
    expect(cli).toContain("install-agents-context");
    expect(cli).toContain("resolveWorkflowInstallPlan");
    expect(cli).toContain("upsertManagedBlock");
    expect(cli).toContain("from-spec-path");
    expect(cli).toContain('"spec-to-issue"');
  });

  it("documents the generic workflow-template catalog and the reactive spec-to-issue entrypoint (TAC-09/TAC-11)", async () => {
    const [workflowDoc, readme, skill] = await Promise.all([
      readFile("docs/workflow.md", "utf8"),
      readFile("README.md", "utf8"),
      readFile("skills/pi-spec-harness/SKILL.md", "utf8"),
    ]);
    const contract = [workflowDoc, readme, skill].join("\n");
    expect(contract).toContain("WORKFLOW_TEMPLATE_CATALOG");
    expect(contract).toContain("install-workflows");
    expect(contract).toContain("spec-to-issue");
    expect(contract).toContain("label-approval-bundling");
    expect(contract).toContain("install-agents-context");
  });
});

// ─── SPEC-010 capability-smoke workflow contract tests ──────────────────────

describe("SPEC-010 capability-smoke reusable workflow contracts", () => {
  it("capability-smoke.yml is valid YAML (no literal newlines inside bash string assignments)", async () => {
    const { load } = await import("js-yaml");
    const raw = await readFile(".github/workflows/capability-smoke.yml", "utf8");
    // load() throws on any YAML syntax error, including unquoted newlines in block scalars
    expect(() => load(raw)).not.toThrow();
    // Additionally verify the problematic fingerprint_input is built with printf, not a literal multi-line string
    expect(raw).toContain("printf");
    expect(raw).not.toMatch(/fingerprint_input="\$\{ACTION_REF\}\n/);
  });
  it("TAC-02: cache restore uses exact key only – no restore-keys prefix matching", async () => {
    const workflow = await readFile(".github/workflows/capability-smoke.yml", "utf8");
    expect(workflow).toContain("actions/cache/restore@v4");
    expect(workflow).toContain("key: ${{ steps.fingerprint.outputs.cache_key }}");
    // No restore-keys line (prefix matching is forbidden by TAC-02)
    expect(workflow).not.toMatch(/restore-keys:/);
  });

  it("TAC-03: only the gate job after a successful verify writes the final attestation cache", async () => {
    const workflow = await readFile(".github/workflows/capability-smoke.yml", "utf8");
    expect(workflow).toContain("actions/cache/save@v4");
    // The save step must be in the attest job which needs the smoke job
    expect(workflow).toContain("needs: [check-attestation, smoke]");
    // The attest job is only triggered when smoke_passed is true
    expect(workflow).toContain("needs.smoke.outputs.smoke_passed == 'true'");
  });

  it("TAC-04: verifier checks bash_ok, write_ok, edit_ok, and exact file content", async () => {
    const workflow = await readFile(".github/workflows/capability-smoke.yml", "utf8");
    expect(workflow).toContain("bash_ok");
    expect(workflow).toContain("write_ok");
    expect(workflow).toContain("edit_ok");
    expect(workflow).toContain("file_content_ok");
    expect(workflow).toContain("smoke_passed");
    expect(workflow).toContain("expected_content");
    expect(workflow).toContain("SMOKE_EDIT_");
    expect(workflow).toContain("SMOKE_WRITE_");
    // TAC-04/TAC-05: tool success is checked per-tool (scoped), not globally
    expect(workflow).toContain("check_tool_success");
    expect(workflow).toContain("jq -e");
    expect(workflow).toContain('.tool == $t and .success == true');
  });

  it("TAC-05: gate job fails the workflow when smoke_passed is not true", async () => {
    const workflow = await readFile(".github/workflows/capability-smoke.yml", "utf8");
    expect(workflow).toContain("needs.smoke.outputs.smoke_passed != 'true'");
    expect(workflow).toContain("exit 1");
  });

  it("TAC-06: cache hit skips the smoke job entirely", async () => {
    const workflow = await readFile(".github/workflows/capability-smoke.yml", "utf8");
    // smoke job has an 'if' condition that only runs on cache miss
    expect(workflow).toContain("needs.check-attestation.outputs.cache_hit != 'true'");
  });

  it("TAC-08: gate job only runs when smoke actually completed – not on skipped/failed prerequisites", async () => {
    const workflow = await readFile(".github/workflows/capability-smoke.yml", "utf8");
    // Gate must guard on smoke result==success, not just cache_hit.
    // Using cache_hit != 'true' would trigger the gate (with the misleading error)
    // even when check-attestation itself failed and smoke was skipped.
    expect(workflow).toContain("needs.smoke.result == 'success'");
    // The old incorrect condition must NOT be present on the gate job
    expect(workflow).toContain("gate:");
    const gateJobSlice = workflow.slice(workflow.indexOf("gate:"));
    expect(gateJobSlice).not.toContain(
      "needs.check-attestation.outputs.cache_hit != 'true'"
    );
  });

  it("TAC-10: workflow grants OIDC but no repository or deployment write permission", async () => {
    const workflow = await readFile(".github/workflows/capability-smoke.yml", "utf8");
    expect(workflow).toContain("id-token: write");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("issues: write");
    expect(workflow).not.toContain("pull-requests: write");
    expect(workflow).not.toContain("deployments: write");
    expect(workflow).not.toContain("git push");
    expect(workflow).not.toContain("gh pr create");
  });

  it("TAC-11: credential check job runs before the smoke and fails with a clear message when both are absent", async () => {
    const workflow = await readFile(".github/workflows/capability-smoke.yml", "utf8");
    expect(workflow).toContain("ANTHROPIC_API_KEY");
    expect(workflow).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(workflow).toContain("has_credentials=false");
    expect(workflow).toContain("exit 1");
  });

  it("TAC-11: secrets are declared in the workflow_call contract so GitHub validates them at parse time", async () => {
    const workflow = await readFile(".github/workflows/capability-smoke.yml", "utf8");
    // Both secrets must appear under on.workflow_call.secrets, not only inside job env blocks
    const callBlock = workflow.slice(workflow.indexOf("workflow_call:"), workflow.indexOf("\njobs:"));
    expect(callBlock).toContain("secrets:");
    expect(callBlock).toContain("ANTHROPIC_API_KEY:");
    expect(callBlock).toContain("CLAUDE_CODE_OAUTH_TOKEN:");
  });

  it("TAC-12/TAC-09: thin caller template declares workflow_call, workflow_dispatch, and push triggers", async () => {
    const { renderCapabilityCallerReference } = await import("../src/capability/capability-caller.js");
    const caller = renderCapabilityCallerReference();
    expect(caller).toContain("workflow_call:");
    expect(caller).toContain("workflow_dispatch:");
    expect(caller).toContain("push:");
    expect(caller).toContain("harness-capability-smoke.yml");
    expect(caller).toContain("harness-bug-triage.yml");
    expect(caller).toContain("secrets: inherit");
  });

  it("TAC-09: push only bridges default-branch changes to a supported workflow_dispatch", async () => {
    const { renderCapabilityCallerReference } = await import("../src/capability/capability-caller.js");
    const caller = renderCapabilityCallerReference();
    expect(caller).toContain("github.event_name == 'push' && github.ref_name == github.event.repository.default_branch");
    expect(caller).toContain(
      'gh workflow run harness-capability-smoke.yml --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME"',
    );
    expect(caller).not.toContain("actions/checkout");
    expect(caller).toContain("GH_TOKEN: ${{ github.token }}");
    expect(caller).toContain("if: github.event_name != 'push'");
  });

  it("release regression: thin caller does not deadlock the reusable workflow concurrency", async () => {
    const { renderCapabilityCallerReference } = await import("../src/capability/capability-caller.js");
    const caller = renderCapabilityCallerReference();
    const reusable = await readFile(".github/workflows/capability-smoke.yml", "utf8");

    // GitHub cancels nested reusable workflows before job start when the
    // top-level caller and called workflow acquire the same concurrency group.
    // Serialization therefore belongs exclusively to the reusable workflow.
    expect(caller).not.toContain("concurrency:");
    expect(caller).not.toContain("harness-capability-smoke-${{ github.repository }}");
    expect(reusable).toContain("concurrency:");
    expect(reusable).toContain("harness-capability-smoke-${{ github.repository }}");
    expect(reusable).toContain("cancel-in-progress: false");
  });

  it("TAC-12: capability-smoke is registered in WORKFLOW_TEMPLATE_CATALOG", async () => {
    const { findWorkflowTemplate, WORKFLOW_TEMPLATE_CATALOG } = await import("../src/workflows/template-catalog.js");
    const entry = findWorkflowTemplate("capability-smoke");
    expect(entry).toBeDefined();
    expect(entry!.targetPath).toBe(".github/workflows/harness-capability-smoke.yml");
    expect(entry!.reusableWorkflowRepoPath).toBe(".github/workflows/capability-smoke.yml");
    expect(WORKFLOW_TEMPLATE_CATALOG.map((t) => t.name)).toContain("capability-smoke");
  });

  it("TAC-01: fingerprint computed inside the workflow uses the same canonical algorithm as the TypeScript module", async () => {
    // The workflow uses: sorted compact JSON of allow list + newline-separated
    // input string. Verify the key structure of the YAML agrees.
    const workflow = await readFile(".github/workflows/capability-smoke.yml", "utf8");
    expect(workflow).toContain("sha256sum");
    expect(workflow).toContain("harness-capability-attestation-");
    expect(workflow).toContain("jq -c 'sort'");
    expect(workflow).toContain("contract_version");
    // TAC-01/version-binding: ACTION_REF must be the hardcoded pin, not an input
    // so the attested version always matches the actually executed action version.
    expect(workflow).toContain('ACTION_REF: "anthropics/claude-code-action@v1.0.94"');
    expect(workflow).not.toContain("ACTION_REF: ${{ inputs.claude-code-action-version }}");
  });

  it("verifier reads execution_file path and cats its contents – not pipes a path string to jq", async () => {
    const workflow = await readFile(".github/workflows/capability-smoke.yml", "utf8");
    // The previous bug: single-quoted bash string containing || '' terminated the quote early.
    expect(workflow).not.toContain("agent_output='${{ steps.agent.outputs.execution_file");
    // execution_file is a path; must read the file before passing to jq/grep.
    expect(workflow).toContain('execution_file_path="${{ steps.agent.outputs.execution_file }}');
    expect(workflow).toContain('agent_output="$(cat "$execution_file_path")"');
    // Must NOT assign the raw path directly to agent_output (would pipe a path string to jq).
    expect(workflow).not.toMatch(/agent_output="\$\{\{ steps\.agent\.outputs\.execution_file \}\}"/);
  });

  it("TAC-10: thin caller grants cache and OIDC permissions but no repository write permission", async () => {
    const { renderCapabilityCallerReference } = await import("../src/capability/capability-caller.js");
    const caller = renderCapabilityCallerReference();
    // Reusable workflow permissions are intersected with the caller permissions.
    expect(caller).toContain("actions: write");
    expect(caller).toContain("id-token: write");
    expect(caller).not.toContain("actions: read");
    expect(caller).not.toContain("contents: write");
    expect(caller).not.toContain("issues: write");
    expect(caller).not.toContain("pull-requests: write");
    expect(caller).not.toContain("deployments: write");
  });

  it("TAC-02: attestation manifest is validated before a cache hit is trusted", async () => {
    const workflow = await readFile(".github/workflows/capability-smoke.yml", "utf8");
    expect(workflow).toContain("Validate existing attestation manifest");
    expect(workflow).toContain("cached_fp");
    expect(workflow).toContain("expected_fp");
    expect(workflow).toContain("schemaVersion");
  });

  it("AC-10: smoke file uses workspace-relative path – no /tmp absolute path in prompt or verifier", async () => {
    const workflow = await readFile(".github/workflows/capability-smoke.yml", "utf8");
    // Prompt and verifier must not reference /tmp/harness-smoke
    expect(workflow).not.toContain("/tmp/harness-smoke");
    // The workspace-relative path pattern must be present in both prompt and verifier
    expect(workflow).toContain("harness-smoke-");
    // Verifier must use GITHUB_WORKSPACE to form the full path
    expect(workflow).toContain("GITHUB_WORKSPACE");
  });

  it("AC-10: pin-mismatch warning fires when claude-code-action-version input differs from the hardcoded pin", async () => {
    const workflow = await readFile(".github/workflows/capability-smoke.yml", "utf8");
    // Check-credentials job must contain the version-mismatch warning step
    expect(workflow).toContain("Warn if claude-code-action-version input differs from hardcoded pin");
    expect(workflow).toContain("::warning::");
    // Must reference the pinned ref explicitly in the warning step
    expect(workflow).toContain('PINNED_REF="anthropics/claude-code-action@v1.0.94"');
  });

  it("AC-08: reusable workflow concurrency is bound to actual contract, not caller input", async () => {
    const workflow = await readFile(".github/workflows/capability-smoke.yml", "utf8");
    // The concurrency group must include the full action pin
    const concurrencySlice = workflow.slice(
      workflow.indexOf("concurrency:"),
      workflow.indexOf("\njobs:")
    );
    expect(concurrencySlice).toContain("anthropics/claude-code-action@v1.0.94");
    // Must NOT use the caller input which might differ
    expect(concurrencySlice).not.toContain("inputs.claude-code-action-version");
  });

  it("AC-08: thin caller delegates the effective capability contract to the reusable workflow", async () => {
    const { renderCapabilityCallerReference } = await import("../src/capability/capability-caller.js");
    const caller = renderCapabilityCallerReference();
    expect(caller).toContain("claude-code-action-version: v1.0.94");
    expect(caller).not.toContain("concurrency:");
    expect(caller).not.toContain("inputs.claude-code-action-version");
    expect(caller).not.toContain("vars.HARNESS_CLAUDE_CODE_ACTION_VERSION");
  });
});

// ---------------------------------------------------------------------------
// SPEC-005 normalizeProcessAuditInput: canonical enums + YAML injection safety
// (Finding 2 regression tests)
// ---------------------------------------------------------------------------

describe("SPEC-005 normalize_process_audit_input.mjs (Finding 2)", () => {
  // Helper: build a minimal valid envelope
  function validEnvelope(overrides: Record<string, unknown> = {}) {
    return {
      schema_version: 1,
      occurred_at: "2026-08-18T12:00:00.000Z",
      process_instance: "run-0056",
      idempotency_key: "idem-001",
      process_code: "DOCUMENTATION_UPDATE",
      actor: "GITHUB_ACTIONS",
      access_role: "GITHUB_ACTIONS_TOKEN",
      supporting_access_roles: [],
      outcome: "SUCCEEDED",
      repository: "org/repo",
      artifact: "docs/runs/generated/RUN-0056.md",
      correlation_ids: [],
      evidence: [],
      reason: "run completed",
      description: "Snapshot written for RUN-0056",
      ...overrides,
    };
  }

  it("accepts canonical actor values including GITHUB_COPILOT, CODEX, HUMAN_PRODUCT_OWNER", async () => {
    const { normalizeProcessAuditInput } = await import("../scripts/normalize_process_audit_input.mjs");
    for (const actor of ["GITHUB_ACTIONS", "COPILOT", "HUMAN", "GITHUB_COPILOT", "HUMAN_PRODUCT_OWNER", "HUMAN_DEVELOPER", "CODEX", "VERCEL", "NEON", "MAKE", "N8N", "IMMOGENT_APPLICATION", "EXTERNAL_SYSTEM"]) {
      expect(() => normalizeProcessAuditInput(validEnvelope({ actor }))).not.toThrow();
    }
  });

  it("accepts canonical outcome values including STARTED, BLOCKED, PARTIAL, REJECTED, SUPERSEDED", async () => {
    const { normalizeProcessAuditInput } = await import("../scripts/normalize_process_audit_input.mjs");
    for (const outcome of ["SUCCEEDED", "FAILED", "SKIPPED", "STARTED", "BLOCKED", "PARTIAL", "REJECTED", "SUPERSEDED"]) {
      expect(() => normalizeProcessAuditInput(validEnvelope({ outcome }))).not.toThrow();
    }
  });

  it("accepts canonical access_role values including all service/session roles", async () => {
    const { normalizeProcessAuditInput } = await import("../scripts/normalize_process_audit_input.mjs");
    for (const access_role of [
      "GITHUB_ACTIONS_TOKEN", "PERSONAL_ACCESS_TOKEN", "APP_INSTALLATION_TOKEN", "HUMAN_BROWSER_SESSION",
      "GITHUB_PERSONAL_ACCESS_TOKEN", "LOCAL_WORKSPACE", "GITHUB_APP_USER_AUTHORIZATION",
      "GITHUB_COPILOT_AGENT_IDENTITY", "CODEX_CHAT_SESSION", "PERSONAL_BROWSER_SESSION",
      "SYSTEM_SERVICE_IDENTITY", "VERCEL_ACCOUNT_SESSION", "VERCEL_AUTOMATION_BYPASS",
      "NEON_ACCOUNT_SESSION", "MAKE_ACCOUNT_SESSION", "N8N_SERVICE_CREDENTIAL",
      "WEBHOOK_HMAC_IDENTITY", "ANONYMOUS_READ_ONLY",
    ]) {
      expect(() => normalizeProcessAuditInput(validEnvelope({ access_role }))).not.toThrow();
    }
  });

  it("accepts canonical access_role values in supporting_access_roles", async () => {
    const { normalizeProcessAuditInput } = await import("../scripts/normalize_process_audit_input.mjs");
    expect(() => normalizeProcessAuditInput(validEnvelope({
      supporting_access_roles: ["CODEX_CHAT_SESSION", "PERSONAL_BROWSER_SESSION"],
    }))).not.toThrow();
  });

  it("rejects unknown values in supporting_access_roles (enum validation)", async () => {
    const { normalizeProcessAuditInput } = await import("../scripts/normalize_process_audit_input.mjs");
    expect(() => normalizeProcessAuditInput(validEnvelope({
      supporting_access_roles: ["UNKNOWN_ROLE"],
    }))).toThrow(/unknown value/);
  });

  it("rejects unknown actor values (not in canonical enum)", async () => {
    const { normalizeProcessAuditInput } = await import("../scripts/normalize_process_audit_input.mjs");
    expect(() => normalizeProcessAuditInput(validEnvelope({ actor: "UNKNOWN_BOT" }))).toThrow(/actor/);
  });

  it("rejects string fields containing backslash characters (YAML injection)", async () => {
    const { normalizeProcessAuditInput } = await import("../scripts/normalize_process_audit_input.mjs");
    expect(() => normalizeProcessAuditInput(validEnvelope({ description: "foo\\bar" }))).toThrow(/backslash/);
  });

  it("rejects string fields containing newline characters (YAML injection)", async () => {
    const { normalizeProcessAuditInput } = await import("../scripts/normalize_process_audit_input.mjs");
    expect(() => normalizeProcessAuditInput(validEnvelope({ description: "line1\nline2" }))).toThrow(/newline/);
  });

  it("rejects string fields containing carriage-return characters (YAML injection)", async () => {
    const { normalizeProcessAuditInput } = await import("../scripts/normalize_process_audit_input.mjs");
    expect(() => normalizeProcessAuditInput(validEnvelope({ reason: "foo\rbar" }))).toThrow(/newline/);
  });

  it("rejects string fields containing control characters (YAML injection)", async () => {
    const { normalizeProcessAuditInput } = await import("../scripts/normalize_process_audit_input.mjs");
    expect(() => normalizeProcessAuditInput(validEnvelope({ reason: "foo\x01bar" }))).toThrow(/control character/);
  });

  it("still rejects double-quote characters", async () => {
    const { normalizeProcessAuditInput } = await import("../scripts/normalize_process_audit_input.mjs");
    expect(() => normalizeProcessAuditInput(validEnvelope({ description: 'has "quotes"' }))).toThrow(/double-quote/);
  });
});
