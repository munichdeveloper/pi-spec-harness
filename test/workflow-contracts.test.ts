import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("GitHub workflow contracts", () => {
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

  it("triggers on pull_request closed events for implementation PR orchestration (TAC-12)", async () => {
    const workflow = await readFile(".github/workflows/harness-gate-trigger.yml", "utf8");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("types: [closed]");
    // Serialises across concurrent runs
    expect(workflow).toContain("cancel-in-progress: false");
  });

  // TAC-09: workflow supports workflow_dispatch and push (own file on default branch)
  it("supports workflow_dispatch and push triggers for bootstrap reconciliation (TAC-09)", async () => {
    const workflow = await readFile(".github/workflows/harness-gate-trigger.yml", "utf8");

    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("harness-gate-trigger.yml");
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

  it("TAC-10: workflow has no contents:write, pull-requests:write, or id-token permission", async () => {
    const workflow = await readFile(".github/workflows/capability-smoke.yml", "utf8");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("pull-requests: write");
    expect(workflow).not.toContain("id-token: write");
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
    expect(caller).toContain("cancel-in-progress: false");
    expect(caller).toContain("secrets: inherit");
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
  });

  it("TAC-02: attestation manifest is validated before a cache hit is trusted", async () => {
    const workflow = await readFile(".github/workflows/capability-smoke.yml", "utf8");
    expect(workflow).toContain("Validate existing attestation manifest");
    expect(workflow).toContain("cached_fp");
    expect(workflow).toContain("expected_fp");
    expect(workflow).toContain("schemaVersion");
  });
});

