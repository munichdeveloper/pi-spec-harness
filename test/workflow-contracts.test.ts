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
    expect(workflow).toContain("anthropics/claude-code-action@${{ inputs.claude-code-action-version }}");
    expect(workflow).toContain(">=1.0.94");
    expect(workflow).toContain("bug-pipeline:in-progress");
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
    expect(helper).toContain("types: [opened, typed, labeled]");
    expect(helper).toContain("github.event.issue.type.name == 'Bug'");
    expect(helper).toContain("contains(github.event.issue.labels.*.name, 'type:bug')");
    expect(helper).toContain("/.github/workflows/bug-triage.yml@");
  });
});
