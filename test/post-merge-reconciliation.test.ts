import { describe, expect, it } from "vitest";
import {
  buildPostMergeAuditEnvelope,
  completePostMergeReconciliation,
  failPostMergeReconciliation,
  reconcilePostMergeEvidence,
  type PostMergePullRequestSnapshot,
} from "../src/reconciliation/post-merge.js";
import { bindPullRequest, initRunState } from "../src/state/state-machine.js";

const head = "a".repeat(40);
const merge = "b".repeat(40);

function run() {
  return bindPullRequest(
    initRunState({
      runId: "bootstrap-v041",
      repository: "munichdeveloper/Immogent",
      requirement: "REQ-014",
      spec: "SPEC-014",
      prApprovalPolicy: "merge-is-approval",
    }),
    100,
    head,
  );
}

function snapshot(overrides: Partial<PostMergePullRequestSnapshot> = {}): PostMergePullRequestSnapshot {
  return {
    number: 100,
    state: "MERGED",
    url: "https://github.com/munichdeveloper/Immogent/pull/100",
    headRefOid: head,
    mergedAt: "2026-09-01T06:37:00Z",
    mergeCommit: { oid: merge },
    mergedBy: { login: "munichdeveloper", __typename: "User" },
    statusCheckRollup: [
      { __typename: "CheckRun", name: "Repository Quality", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "StatusContext", context: "Vercel", state: "SUCCESS" },
    ],
    reviews: [{ id: 42, state: "COMMENTED", commitId: head }],
    reviewThreads: [{ id: "thread-1", isResolved: true, isOutdated: false }],
    ...overrides,
  };
}

function reconcile(state = run(), observed = snapshot()) {
  return reconcilePostMergeEvidence({
    state,
    snapshot: observed,
    actor: "CODEX",
    evidence: [observed.url, "checks:2:all-successful", "review-threads:1:none-open-current"],
  });
}

describe("post-merge reconciliation", () => {
  it("atomically records implementation, verification, review and human merge evidence", () => {
    const state = reconcile();

    expect(state.implementationEvidence).toMatchObject({ type: "direct", commitSha: head, actor: "CODEX" });
    expect(state.verificationEvidence?.headSha).toBe(head);
    expect(state.reviewEvidence?.headSha).toBe(head);
    expect(state.deliveryMergeCommitSha).toBe(merge);
    expect(state.deliveryMergedAt).toBe("2026-09-01T06:37:00Z");
    expect(state.gates.find((gate) => gate.id === "delivery-merge-approval-pr100")).toMatchObject({
      result: "passed",
      decision: { approved: true, by: "munichdeveloper" },
    });
    expect(state.gates.find((gate) => gate.id === "post-merge-evidence-reconciliation")?.result).toBe("pending");
  });

  it("is idempotent after audit confirmation", () => {
    const first = completePostMergeReconciliation(reconcile(), ["audit:key", "audit-confirmed-at:now"]);
    const second = completePostMergeReconciliation(reconcile(first), ["audit:key", "audit-confirmed-at:now"]);
    expect(second).toEqual(first);
  });

  it("rejects a stale or changed PR head", () => {
    expect(() => reconcile(run(), snapshot({ headRefOid: "c".repeat(40) }))).toThrow(/does not match bound head/);
  });

  it.each([
    ["missing checks", [], /no status-check evidence/],
    [
      "pending check",
      [{ __typename: "CheckRun" as const, name: "CI", status: "IN_PROGRESS", conclusion: "" }],
      /blocking checks/,
    ],
    [
      "failed status",
      [{ __typename: "StatusContext" as const, context: "Vercel", state: "FAILURE" }],
      /blocking checks/,
    ],
  ])("rejects %s", (_name, checks, expected) => {
    expect(() => reconcile(run(), snapshot({ statusCheckRollup: checks }))).toThrow(expected);
  });

  it("rejects unresolved current review threads", () => {
    expect(() => reconcile(run(), snapshot({
      reviewThreads: [{ id: "thread-open", isResolved: false, isOutdated: false }],
    }))).toThrow(/unresolved current review thread/);
  });

  it("accepts outdated unresolved threads but requires submitted review evidence", () => {
    expect(() => reconcile(run(), snapshot({
      reviewThreads: [{ id: "thread-old", isResolved: false, isOutdated: true }],
    }))).not.toThrow();
    expect(() => reconcile(run(), snapshot({ reviews: [] }))).toThrow(/no submitted review evidence/);
    expect(() => reconcile(run(), snapshot({
      reviews: [{ id: 1, state: "DISMISSED", commitId: head }],
    }))).toThrow(/no submitted review evidence/);
  });

  it("never downgrades an audit-confirmed successful reconciliation on a retry", () => {
    const completed = completePostMergeReconciliation(reconcile(), [
      "audit:key",
      "audit-confirmed-at:2026-09-01T00:00:00Z",
    ]);

    expect(failPostMergeReconciliation(completed, ["later transient API failure"])).toEqual(completed);
  });

  it("rejects bot or app merge actors", () => {
    expect(() => reconcile(run(), snapshot({
      mergedBy: { login: "github-actions[bot]", __typename: "Bot" },
    }))).toThrow(/non-human actor/);
  });

  it("does not overwrite evidence for another head", () => {
    const conflicting = {
      ...run(),
      implementationEvidence: {
        type: "direct" as const,
        commitSha: "d".repeat(40),
        actor: "CODEX",
        evidence: ["existing"],
        verifiedAt: "2026-08-31T00:00:00Z",
      },
    };
    expect(() => reconcile(conflicting)).toThrow(/already records implementation evidence/);
  });

  it("builds a complete deterministic process-audit envelope", () => {
    const state = reconcile();
    const audit = buildPostMergeAuditEnvelope({
      state,
      trackingIssue: 99,
      snapshot: snapshot(),
      actor: "CODEX",
      accessRole: "GITHUB_PERSONAL_ACCESS_TOKEN",
      reason: "Reconcile completed delivery.",
      description: "Verified live GitHub evidence and persisted it atomically.",
      evidence: [snapshot().url],
    });

    expect(audit).toMatchObject({
      schema_version: 1,
      occurred_at: "2026-09-01T06:37:00.000Z",
      idempotency_key: `post-merge-reconcile:bootstrap-v041:pr100:${head}:v1`,
      process_code: "PROCESS_RECONCILIATION",
      actor: "CODEX",
      access_role: "GITHUB_PERSONAL_ACCESS_TOKEN",
      artifact: merge,
      outcome: "SUCCEEDED",
    });
    expect(audit.reason).toBeTruthy();
    expect(audit.description).toBeTruthy();
    expect(audit.evidence).toContain(snapshot().url);
  });
});
