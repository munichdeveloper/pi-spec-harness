import { describe, expect, it } from "vitest";
import {
  acknowledgeRejectedGate,
  bindDeliveryPullRequest,
  bindImplementationPullRequest,
  bindPullRequest,
  classifyDeliveryPrMergeEffect,
  computeNextAction,
  finishIteration,
  hasOpenHumanGate,
  isMergeApprovalGate,
  needsDeliveryMergeReconciliation,
  recordDeliveryMergeEffect,
  initRunState,
  reconcileInit,
  resolveGate,
  startIteration,
  transitionPhase,
  upsertDocumentationSnapshot,
  upsertGate,
} from "../src/state/state-machine.js";

function baseRunOptions() {
  return {
    runId: "test-run-001",
    repository: "munichdeveloper/Immogent",
    requirement: "REQ-001",
    spec: "SPEC-011",
  };
}

function baseRun() {
  return initRunState(baseRunOptions());
}

describe("state-machine", () => {
  it("classifies canonical and legacy delivery merge approval gates consistently", () => {
    const gate = (id: string, type: "human" | "merge" = "human") => ({
      id,
      type,
      result: "passed" as const,
      createdAt: "2026-08-22T16:29:30Z",
      updatedAt: "2026-08-22T16:29:30Z",
    });

    expect(isMergeApprovalGate(gate("delivery-merge-approval"))).toBe(true);
    expect(isMergeApprovalGate(gate("delivery-merge-approval-pr60"))).toBe(true);
    expect(isMergeApprovalGate(gate("merge-approval"))).toBe(true);
    expect(isMergeApprovalGate(gate("merge-approval-pr60"))).toBe(true);
    expect(isMergeApprovalGate(gate("technical-verification", "merge"))).toBe(true);
    expect(isMergeApprovalGate(gate("delivery-approval"))).toBe(false);
  });

  it("accepts a passed canonical delivery merge approval for the exact bound head", () => {
    const approvedHeadSha = "a".repeat(40);
    let state = {
      ...baseRun(),
      phase: "merge" as const,
      deliveryPullRequest: 60,
      deliveryHeadSha: approvedHeadSha,
    };
    state = upsertGate(state, {
      id: "delivery-merge-approval",
      type: "human",
      question: `Merge PR #60 at ${approvedHeadSha}?`,
    });
    state = resolveGate(state, "delivery-merge-approval", {
      result: "passed",
      decision: { approved: true, by: "munichdeveloper", at: "2026-08-22T16:29:30Z" },
    });

    state = recordDeliveryMergeEffect(state, {
      pullRequest: 60,
      approvedHeadSha,
      mergeCommitSha: "b".repeat(40),
      mergedBy: "human-user",
      mergedAt: "2026-08-22T16:31:56Z",
    });

    expect(state.deliveryMergeCommitSha).toBe("b".repeat(40));
    expect(state.deliveryMergedAt).toBe("2026-08-22T16:31:56Z");
  });

  it("marks an approved delivery merge without persisted effect for reconciliation", () => {
    // Use explicit legacy policy: a pre-existing passed gate is required.
    // SPEC-015 TAC-07: label-authorizes-auto-merge must not be affected by
    // the new merge-is-approval default.
    let state = bindDeliveryPullRequest(
      initRunState({ ...baseRunOptions(), prApprovalPolicy: "label-authorizes-auto-merge" }),
      60, "a".repeat(40),
    );
    state = upsertGate(state, { id: "delivery-merge-approval", type: "human", question: "Merge?" });
    expect(needsDeliveryMergeReconciliation(state)).toBe(false);

    state = resolveGate(state, "delivery-merge-approval", {
      result: "passed",
      decision: { approved: true, by: "munichdeveloper", at: "2026-08-22T16:29:30Z" },
    });
    expect(needsDeliveryMergeReconciliation(state)).toBe(true);

    state = recordDeliveryMergeEffect(state, {
      pullRequest: 60,
      approvedHeadSha: "a".repeat(40),
      mergeCommitSha: "b".repeat(40),
      mergedBy: "human-user",
      mergedAt: "2026-08-22T16:31:56Z",
    });
    expect(needsDeliveryMergeReconciliation(state)).toBe(false);
  });

  it("reconciles legacy pull request bindings from existing run states", () => {
    let state = bindPullRequest(baseRun(), 60, "a".repeat(40));
    state = upsertGate(state, { id: "merge-approval", type: "human", question: "Merge?" });
    state = resolveGate(state, "merge-approval", {
      result: "passed",
      decision: { approved: true, by: "munichdeveloper", at: "2026-08-22T16:29:30Z" },
    });

    expect(state.deliveryPullRequest).toBeUndefined();
    expect(state.deliveryHeadSha).toBeUndefined();
    expect(needsDeliveryMergeReconciliation(state)).toBe(true);
  });

  it("invalidates a canonical delivery merge approval when the bound head changes", () => {
    // This test verifies the legacy label-authorizes-auto-merge policy where
    // a pre-existing passed gate is required. Use explicit policy so the test
    // is not affected by the SPEC-015 merge-as-approval default. TAC-07.
    let state = bindDeliveryPullRequest(
      initRunState({ ...baseRunOptions(), prApprovalPolicy: "label-authorizes-auto-merge" }),
      60, "a".repeat(40),
    );
    state = upsertGate(state, { id: "delivery-merge-approval", type: "human", question: "Merge?" });
    state = resolveGate(state, "delivery-merge-approval", {
      result: "passed",
      decision: { approved: true, by: "munichdeveloper", at: "2026-08-22T16:29:30Z" },
    });

    state = bindDeliveryPullRequest(state, 60, "b".repeat(40));

    expect(state.gates.some((gate) => gate.id === "delivery-merge-approval")).toBe(false);
    expect(() => recordDeliveryMergeEffect(state, {
      pullRequest: 60,
      approvedHeadSha: "b".repeat(40),
      mergeCommitSha: "c".repeat(40),
      mergedBy: "human-user",
      mergedAt: "2026-08-22T16:31:56Z",
    })).toThrow(/passed merge approval gate/);
  });

  it("initializes a run in phase 'requirement' with no gates", () => {
    const state = baseRun();
    expect(state.phase).toBe("requirement");
    expect(state.gates).toHaveLength(0);
    expect(computeNextAction(state).action).toBe("advance-phase");
  });

  it("reconcileInit is idempotent for matching immutable fields", () => {
    const state = baseRun();
    const again = reconcileInit(state, {
      runId: state.runId,
      repository: state.repository,
      requirement: state.requirement,
      spec: state.spec,
    });
    expect(again).toBe(state);
  });

  it("reconcileInit throws on conflicting immutable fields", () => {
    const state = baseRun();
    expect(() =>
      reconcileInit(state, {
        runId: state.runId,
        repository: state.repository,
        requirement: state.requirement,
        spec: "SPEC-999",
      }),
    ).toThrow(/spec/);
  });

  it("an open human gate blocks computeNextAction regardless of phase", () => {
    let state = baseRun();
    state = upsertGate(state, { id: "spec-approval", type: "human", question: "Approve SPEC-011?" });
    expect(hasOpenHumanGate(state)?.id).toBe("spec-approval");
    expect(computeNextAction(state).action).toBe("await-human-gate");
  });

  it("resolving a human gate with passed+approved clears the block", () => {
    let state = baseRun();
    state = upsertGate(state, { id: "spec-approval", type: "human", question: "Approve SPEC-011?" });
    state = resolveGate(state, "spec-approval", {
      result: "passed",
      decision: { approved: true, by: "munichdeveloper", at: new Date().toISOString() },
    });
    expect(hasOpenHumanGate(state)).toBeUndefined();
    expect(computeNextAction(state).action).toBe("advance-phase");
  });

  it("a rejected human gate resolves (no longer 'open') but surfaces as human-gate-rejected", () => {
    let state = baseRun();
    state = upsertGate(state, { id: "merge-approval", type: "human", question: "Merge PR #1?" });
    state = resolveGate(state, "merge-approval", {
      result: "failed",
      decision: { approved: false, by: "munichdeveloper", at: new Date().toISOString() },
    });
    expect(hasOpenHumanGate(state)).toBeUndefined();
    expect(computeNextAction(state).action).toBe("human-gate-rejected");
  });

  it("acknowledging a rejected gate clears human-gate-rejected and allows progress again", () => {
    let state = baseRun();
    state = upsertGate(state, { id: "merge-approval", type: "human", question: "Merge PR #1?" });
    state = resolveGate(state, "merge-approval", {
      result: "failed",
      decision: { approved: false, by: "munichdeveloper", at: new Date().toISOString() },
    });
    state = acknowledgeRejectedGate(state, "merge-approval", "run cancelled, see follow-up run");
    expect(computeNextAction(state).action).toBe("advance-phase");
  });

  it("escalates once the automatic iteration cap is reached", () => {
    let state = baseRun();
    for (let i = 0; i < state.maxAutomaticIterations; i++) {
      const started = startIteration(state);
      state = finishIteration(started.state, started.iteration.index, "failed", ["still broken"]);
    }
    expect(computeNextAction(state).action).toBe("escalate-iteration-cap");
  });

  it("continues after a human resolves the automatic iteration-cap escalation", () => {
    let state = baseRun();
    for (let i = 0; i < state.maxAutomaticIterations; i++) {
      const started = startIteration(state);
      state = finishIteration(started.state, started.iteration.index, "failed", ["still broken"]);
    }
    state = upsertGate(state, {
      id: "needs-human-escalation",
      type: "human",
      question: "Continue manually?",
    });
    state = resolveGate(state, "needs-human-escalation", {
      result: "passed",
      decision: { approved: true, by: "test", at: new Date().toISOString() },
    });

    expect(computeNextAction(state).action).toBe("advance-phase");
    expect(transitionPhase(state, "spec").phase).toBe("spec");
  });

  it("does not escalate below the iteration cap", () => {
    let state = baseRun();
    const started = startIteration(state);
    state = finishIteration(started.state, started.iteration.index, "failed", ["one failure"]);
    expect(computeNextAction(state).action).toBe("advance-phase");
  });

  it("reports run-complete once phase is complete and no gates are open", () => {
    let state = baseRun();
    state = { ...state, phase: "complete" };
    expect(computeNextAction(state).action).toBe("run-complete");
  });

  it("blocks on pending and failed technical gates", () => {
    let state = baseRun();
    state = upsertGate(state, { id: "verification", type: "review" });
    expect(computeNextAction(state).action).toBe("await-technical-gate");
    expect(() => transitionPhase(state, "spec")).toThrow(/technical gate 'verification' is pending/);

    state = resolveGate(state, "verification", { result: "failed", evidence: ["ci/run/1"] });
    expect(computeNextAction(state).action).toBe("technical-gate-failed");
    expect(() => transitionPhase(state, "spec")).toThrow(/technical gate 'verification' is failed/);

    state = resolveGate(state, "verification", { result: "passed", evidence: ["ci/run/2"] });
    expect(transitionPhase(state, "spec").phase).toBe("spec");
  });

  it("does not advance while an implementation review thread remains actionable", () => {
    let state = bindImplementationPullRequest(baseRun(), 62, "a".repeat(40));
    state = {
      ...state,
      reviewThreads: [{
        idempotencyKey: "owner/repo:pr62:review1:threadT1:sha" + "a".repeat(40),
        repository: state.repository,
        pullRequest: 62,
        reviewId: 1,
        threadId: "T1",
        reviewedHeadSha: "a".repeat(40),
        reviewer: "copilot-pull-request-reviewer[bot]",
        reviewerType: "Bot",
        status: "actionable",
        auditedAt: "2026-08-23T12:00:00Z",
      }],
    };
    expect(computeNextAction(state).action).toBe("await-technical-gate");
    expect(() => transitionPhase(state, "spec")).toThrow(/unresolved actionable review threads/i);
  });

  it("allows only an idempotent or single-step phase transition", () => {
    const state = baseRun();
    expect(transitionPhase(state, "requirement")).toBe(state);
    expect(() => transitionPhase(state, "implementation")).toThrow(/invalid phase transition/);
    const spec = transitionPhase(state, "spec");
    expect(() => transitionPhase(spec, "requirement")).toThrow(/invalid phase transition/);
  });

  it("requires persisted delivery merge evidence before complete", () => {
    const approvedHeadSha = "a".repeat(40);
    const mergeCommitSha = "b".repeat(40);
    const gateId = `merge-approval-pr47-sha${approvedHeadSha.slice(0, 8)}`;
    let state = {
      ...baseRun(),
      phase: "merge" as const,
      deliveryPullRequest: 47,
      deliveryHeadSha: approvedHeadSha,
    };
    expect(() => transitionPhase(state, "complete")).toThrow(/persisted delivery merge evidence/);
    state = upsertGate(state, { id: gateId, type: "human", question: "Approve delivery merge?" });
    state = resolveGate(state, gateId, {
      result: "passed",
      decision: { approved: true, by: "test", at: new Date().toISOString() },
    });
    expect(computeNextAction(state).action).toBe("await-technical-gate");
    expect(() => transitionPhase(state, "complete")).toThrow(/persisted delivery merge evidence/);

    state = recordDeliveryMergeEffect(state, {
      pullRequest: 47,
      approvedHeadSha,
      mergeCommitSha,
      mergedBy: "human-user",
      mergedAt: "2026-08-18T13:19:11Z",
    });

    expect(recordDeliveryMergeEffect(state, {
      pullRequest: 47,
      approvedHeadSha,
      mergeCommitSha,
      mergedBy: "human-user",
      mergedAt: "2026-08-18T13:19:11Z",
    })).toBe(state);
    expect(state.deliveryMergeCommitSha).toBe(mergeCommitSha);
    expect(state.deliveryMergedAt).toBe("2026-08-18T13:19:11Z");

    // SPEC-012 TAC-04: after merge evidence, computeNextAction requests documentation
    expect(computeNextAction(state).action).toBe("persist-run-documentation");
    // SPEC-012 TAC-05: transitionPhase to complete requires a persisted, audited snapshot
    expect(() => transitionPhase(state, "complete")).toThrow(/persisted and audited documentation snapshot/);

    state = upsertDocumentationSnapshot(state, {
      schemaVersion: 1,
      status: "persisted",
      idempotencyKey: "test-idem-key",
      path: "docs/runs/generated/RUN-0047-test.md",
      indexPath: "docs/runs/RUN-INDEX.md",
      obsidianBasePath: "docs/runs/Runs.base",
      generatedAt: "2026-08-18T14:00:00Z",
      sourceHeadSha: mergeCommitSha,
      commitSha: "f".repeat(40),
      auditIdempotencyKey: "test-audit-key",
      auditConfirmedAt: "2026-08-18T14:01:00Z",
    });
    expect(computeNextAction(state).action).toBe("advance-phase");
    expect(transitionPhase(state, "complete").phase).toBe("complete");
  });

  it("skips delivery merge-effect persistence for implementation PR merge events", () => {
    let state = bindDeliveryPullRequest(baseRun(), 47, "a".repeat(40));
    state = bindImplementationPullRequest(state, 48, "b".repeat(40));

    expect(classifyDeliveryPrMergeEffect(state, 48)).toEqual({
      kind: "skip",
      deliveryPullRequest: 47,
      observedPullRequest: 48,
    });
    expect(classifyDeliveryPrMergeEffect(state, 47)).toEqual({
      kind: "record",
      deliveryPullRequest: 47,
    });
  });

  it("binds one PR, permits a new checkpoint SHA, and invalidates review evidence", () => {
    const state = baseRun();
    const sha = "a".repeat(40);
    let bound = bindPullRequest(state, 42, sha);
    expect(bound.pullRequest).toBe(42);
    expect(bound.pullRequestHeadSha).toBe(sha);
    expect(bindPullRequest(bound, 42, sha)).toBe(bound);
    expect(bindPullRequest(bound, 42, sha.toUpperCase())).toBe(bound);
    expect(() => bindPullRequest(bound, 43, sha)).toThrow(/already bound to PR/);

    bound = upsertGate(bound, { id: "verification", type: "review" });
    bound = resolveGate(bound, "verification", { result: "passed", evidence: ["ci/old"] });
    const rebound = bindPullRequest(bound, 42, "b".repeat(40));
    expect(rebound.pullRequestHeadSha).toBe("b".repeat(40));
    expect(rebound.gates.find((gate) => gate.id === "verification")?.result).toBe("pending");
    expect(rebound.gates.find((gate) => gate.id === "verification")?.evidence).toBeUndefined();
    expect(() => bindPullRequest(state, 42, "short")).toThrow(/full 40-character/);
  });

  it("marks actionable implementation-review threads outdated when the bound HEAD changes", () => {
    const oldSha = "a".repeat(40);
    let state = bindImplementationPullRequest(baseRun(), 90, oldSha);
    state = {
      ...state,
      reviewThreads: [{
        idempotencyKey: `owner/repo:pr90:review1:threadT1:sha${oldSha}`,
        repository: state.repository,
        pullRequest: 90,
        reviewId: 1,
        threadId: "T1",
        reviewedHeadSha: oldSha,
        reviewer: "copilot-pull-request-reviewer",
        reviewerType: "Bot",
        status: "actionable",
        classifiedAt: "2026-08-24T10:00:00Z",
        auditedAt: "2026-08-24T10:00:00Z",
      }],
    };

    const rebound = bindImplementationPullRequest(state, 90, "b".repeat(40));
    expect(rebound.reviewThreads?.[0]?.status).toBe("outdated");
  });

  it("reconciles stale review threads even when PR and current HEAD were already bound", () => {
    const currentSha = "b".repeat(40);
    let state = bindImplementationPullRequest(baseRun(), 90, currentSha);
    state = {
      ...state,
      reviewThreads: [{
        idempotencyKey: `owner/repo:pr90:review1:threadT1:sha${"a".repeat(40)}`,
        repository: state.repository,
        pullRequest: 90,
        reviewId: 1,
        threadId: "T1",
        reviewedHeadSha: "a".repeat(40),
        reviewer: "copilot-pull-request-reviewer",
        reviewerType: "Bot",
        status: "actionable",
        classifiedAt: "2026-08-24T10:00:00Z",
        auditedAt: "2026-08-24T10:00:00Z",
      }],
    };

    const reconciled = bindImplementationPullRequest(state, 90, currentSha);
    expect(reconciled.reviewThreads?.[0]?.status).toBe("outdated");
  });
});
