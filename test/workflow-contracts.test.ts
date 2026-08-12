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
  });

  it("includes strict bug trigger filtering in the thin reference workflow template (TAC-02/TAC-04)", async () => {
    const cli = await readFile("src/cli.ts", "utf8");
    const helper = await readFile("src/bug/workflow-reference.ts", "utf8");

    expect(cli).toContain("install-bug-workflow");
    expect(cli).toContain("workflow conflict");
    expect(helper).toContain("types: [typed, labeled]");
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
