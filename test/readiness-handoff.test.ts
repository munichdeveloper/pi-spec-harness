import { afterEach, describe, expect, it, vi } from "vitest";
import { github } from "../src/github/gh.js";
import { runReadinessHandoff } from "../src/spec/readiness-handoff.js";
import { parseStateFromBody } from "../src/state/issue-store.js";
import { AuditConfirmationPendingError } from "../src/audit/confirmation-pending.js";

afterEach(() => vi.restoreAllMocks());
function setup() {
  const revision = "a".repeat(40);
  const issues: Array<{ number: number; title: string; body: string; state: string; url: string; labels: { name: string }[] }> = [];
  vi.spyOn(github, "getBranchSha").mockResolvedValue(revision);
  vi.spyOn(github, "getFileContent").mockResolvedValue({ blobSha: revision, content: "---\nid: SPEC-001\ntitle: Feature\nstatus: approved\nrequirements:\n  - REQ-001\n---\n# Feature\n" });
  vi.spyOn(github, "listReadinessIssues").mockImplementation(async () => structuredClone(issues));
  vi.spyOn(github, "ensureLabel").mockResolvedValue();
  vi.spyOn(github, "createIssue").mockImplementation(async (repository, issue) => {
    const number = issues.length + 96; const url = `https://github.com/${repository}/issues/${number}`;
    issues.push({ number, url, title: issue.title, body: issue.body, state: "open", labels: (issue.labels ?? []).map(name => ({ name })) });
    return { repository, number, url };
  });
  vi.spyOn(github, "viewIssue").mockImplementation(async (_repo, number) => ({ ...structuredClone(issues.find(i => i.number === number)!), assignees: [], comments: [] }));
  vi.spyOn(github, "updateIssueBody").mockImplementation(async (_repo, number, body) => { issues.find(i => i.number === number)!.body = body; });
  vi.spyOn(github, "addLabels").mockImplementation(async (_repo, number, names) => { issues.find(i => i.number === number)!.labels.push(...names.map(name => ({ name }))); });
  vi.spyOn(github, "removeLabels").mockImplementation(async (_repo, number, names) => { const issue = issues.find(i => i.number === number)!; issue.labels = issue.labels.filter(l => !names.includes(l.name)); });
  vi.spyOn(github, "dispatchProcessAuditEnvelopeV1").mockResolvedValue();
  vi.spyOn(github, "confirmAuditEventInJournal").mockResolvedValue("confirmed");
  const runs: Record<string, unknown>[] = [];
  vi.spyOn(github, "listReadinessWorkflowRuns").mockImplementation(async () => runs);
  vi.spyOn(github, "dispatchReadinessWorkflow").mockImplementation(async (repository, workflowId, _ref, inputs) => {
    runs.push({ id: 1000 + runs.length, workflow_id: workflowId, path: ".github/workflows/executor.yml", head_sha: revision,
      event: "workflow_dispatch", display_title: `readiness:${inputs["work-key"]}`, actor: { id: 10 }, triggering_actor: { id: 10 },
      repository: { full_name: repository }, head_repository: { full_name: repository }, run_attempt: 1, status: "in_progress", conclusion: null });
  });
  vi.spyOn(github, "viewReadinessWorkflowRun").mockImplementation(async (_repo, id) => structuredClone(runs.find(r => r.id === id)));
  const policy = { id: "synthetic", authorized: true, available: true, capabilities: ["spike", "implementation"] as Array<"spike" | "implementation">, maxTaskCost: 0 };
  const input = { repository: "acme/product", branch: "main", specPath: "docs/SPEC-001.md", revision, costCeiling: 0,
    contract: { schemaVersion: 1, specRevision: revision, blockers: [{ id: "coordinates", kind: "technical", stage: "implementation", owner: "research", question: "Coordinates?", criteria: ["exists"], maxAttempts: 2 }] },
    workflows: { synthetic: { repository: "acme/product", branch: "main", workflowId: 42, workflowPath: ".github/workflows/executor.yml", workflowRevision: revision, allowedActorIds: [10] } },
    currentExecutors: async () => [policy], audit: { directory: "docs/process-audit/journal", branch: "main", actor: "GITHUB_ACTIONS", accessRole: "GITHUB_ACTIONS_TOKEN" } };
  return { input, issues, runs, policy };
}
describe("SPEC-016 complete GitHub controller (API simulation, not hosted E2E)", () => {
  it("waits on delayed acknowledgement and resumes the same event without duplicate work", async () => {
    const f = setup();
    vi.mocked(github.confirmAuditEventInJournal).mockImplementationOnce(async (_repo, _dir, key) => {
      throw new AuditConfirmationPendingError(key, "receiver queued");
    });
    expect(await runReadinessHandoff(f.input)).toMatchObject({ action: "await-audit", retryAfterSeconds: 600 });
    expect(f.issues).toHaveLength(1);
    expect(f.runs).toHaveLength(0);
    const first = vi.mocked(github.dispatchProcessAuditEnvelopeV1).mock.calls[0][1];
    expect(parseStateFromBody(f.issues[0].body).readinessAudits?.[first.idempotency_key]).toBeDefined();
    await runReadinessHandoff(f.input);
    expect(vi.mocked(github.dispatchProcessAuditEnvelopeV1).mock.calls[1][1]).toEqual(first);
    await runReadinessHandoff(f.input);
    expect(f.issues).toHaveLength(3);
    expect(f.runs).toHaveLength(1);
  });
  it("does not downgrade permission or invalid-journal failures to pending", async () => {
    const f = setup();
    vi.mocked(github.confirmAuditEventInJournal).mockRejectedValue(new Error("HTTP 403"));
    await expect(runReadinessHandoff(f.input)).rejects.toThrow("HTTP 403");
    expect(f.runs).toHaveLength(0);
  });
  it("drains an old quota decision before dispatch after availability changes", async () => {
    const f = setup(); f.policy.available = false;
    let pendingKey = "";
    vi.mocked(github.dispatchProcessAuditEnvelopeV1).mockImplementation(async (_repo, event) => {
      if (event.description.includes("Readiness await-executor")) pendingKey = event.idempotency_key;
    });
    vi.mocked(github.confirmAuditEventInJournal).mockImplementation(async (_repo, _dir, key) => {
      if (key === pendingKey) throw new AuditConfirmationPendingError(key, "queued");
      return "confirmed";
    });
    expect((await runReadinessHandoff(f.input)).action).toBe("await-audit");
    f.policy.available = true;
    expect((await runReadinessHandoff(f.input)).action).toBe("await-audit");
    expect(f.runs).toHaveLength(0);
    vi.mocked(github.confirmAuditEventInJournal).mockResolvedValue("confirmed");
    await runReadinessHandoff(f.input);
    expect(f.runs).toHaveLength(1);
    const events = vi.mocked(github.dispatchProcessAuditEnvelopeV1).mock.calls
      .map(([, event]) => event).filter(event => event.idempotency_key === pendingKey);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual(events[0]);
  });
  it("does not invalidate readiness when audit commits move the branch without changing the spec", async () => {
    const f = setup();
    await runReadinessHandoff(f.input);
    const sourceCommit = "b".repeat(40);
    vi.mocked(github.getBranchSha).mockResolvedValue(sourceCommit);
    const result = await runReadinessHandoff({ ...f.input, revision: sourceCommit });
    expect(result.action).toBe("observe-work");
    expect(result.reason).toBe("spike-result-pending");
    expect(f.runs).toHaveLength(1);
    expect(parseStateFromBody(f.issues[0].body).readiness?.revision).toBe(f.input.revision);
  });
  it("connects approved spec, one run, implementation issue, bounded spike and automatic continuation", async () => {
    const f = setup();
    expect((await runReadinessHandoff(f.input)).action).toBe("observe-work");
    expect(f.issues).toHaveLength(3);
    let state = parseStateFromBody(f.issues[0].body);
    const spike = state.readiness!.work[0];
    expect(state.readinessAudits && Object.keys(state.readinessAudits).length).toBeGreaterThanOrEqual(5);
    await runReadinessHandoff(f.input);
    expect(f.runs).toHaveLength(1);
    Object.assign(f.runs[0], { status: "completed", conclusion: "success" });
    vi.spyOn(github, "listReadinessResultArtifacts").mockResolvedValue([{ id: 1, name: `readiness-result-${spike.key.slice(10)}-1`, expired: false, size_in_bytes: 1000, workflow_run: { id: 1000, head_sha: f.input.revision } }]);
    vi.spyOn(github, "downloadReadinessResult").mockResolvedValue({ schemaVersion: 1, workKey: spike.key, attempt: 1, executorId: "synthetic", issue: spike.issue, runId: 1000, runAttempt: 1, blockerId: "coordinates", specRevision: f.input.revision, verdict: "passed", verifiedCriteria: ["exists"], references: ["synthetic:fixture"], changes: [] });
    expect((await runReadinessHandoff(f.input)).reason).toBe("implementation-dispatched");
    state = parseStateFromBody(f.issues[0].body);
    expect(state.readiness!.work.map(w => w.kind)).toEqual(["spike", "implementation"]);
    expect(f.issues).toHaveLength(3);
    expect(f.runs).toHaveLength(2);
    expect(f.issues[1].labels).toEqual([{ name: "harness:readiness-ready" }]);
    const initialAudits = vi.mocked(github.dispatchProcessAuditEnvelopeV1).mock.calls.filter(([, event]) => event.description.startsWith("Canonical run"));
    expect(new Set(initialAudits.map(([, event]) => event.occurred_at)).size).toBe(1);
  });
  it("keeps unavailable executors visible without dispatching or activating legacy labels", async () => {
    const f = setup(); f.policy.available = false;
    expect((await runReadinessHandoff(f.input)).action).toBe("await-executor");
    expect(f.runs).toHaveLength(0);
    expect(f.issues[1].labels).toEqual([{ name: "harness:readiness-executor" }]);
  });
});
