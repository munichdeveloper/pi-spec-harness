import { findBlockingStatusChecks, type StatusCheckRollupItem } from "../github/gh.js";
import {
  findGate,
  formatCanonicalRunId,
  recordDeliveryMergeEffect,
  recordDirectImplementationEvidence,
  recordReviewEvidence,
  recordVerificationEvidence,
  resolveGate,
  upsertGate,
} from "../state/state-machine.js";
import type { RunState } from "../state/types.js";

export const POST_MERGE_RECONCILIATION_GATE = "post-merge-evidence-reconciliation";

export interface PostMergeReview {
  id: number;
  state: string;
  commitId: string;
}

export interface PostMergeReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
}

export interface PostMergePullRequestSnapshot {
  number: number;
  state: string;
  url: string;
  headRefOid: string;
  mergedAt: string | null;
  mergeCommit: { oid?: string } | null;
  mergedBy: { login?: string; __typename?: string } | null;
  statusCheckRollup: StatusCheckRollupItem[];
  reviews: PostMergeReview[];
  reviewThreads: PostMergeReviewThread[];
}

export interface PostMergeReconciliationInput {
  state: RunState;
  snapshot: PostMergePullRequestSnapshot;
  actor: string;
  evidence: string[];
}

function evidenceHead(state: RunState): string | undefined {
  const evidence = state.implementationEvidence;
  return evidence?.type === "pull-request" ? evidence.headSha : evidence?.commitSha;
}

function assertExistingEvidenceMatches(state: RunState, headSha: string): void {
  const currentImplementationHead = evidenceHead(state);
  if (currentImplementationHead && currentImplementationHead.toLowerCase() !== headSha) {
    throw new Error(
      `run '${state.runId}' already records implementation evidence for ${currentImplementationHead}; refusing ${headSha}`,
    );
  }
  if (state.verificationEvidence && state.verificationEvidence.headSha.toLowerCase() !== headSha) {
    throw new Error(
      `run '${state.runId}' already records verification evidence for ${state.verificationEvidence.headSha}; refusing ${headSha}`,
    );
  }
  if (state.reviewEvidence && state.reviewEvidence.headSha.toLowerCase() !== headSha) {
    throw new Error(
      `run '${state.runId}' already records review evidence for ${state.reviewEvidence.headSha}; refusing ${headSha}`,
    );
  }
}

/**
 * Atomically materialize already-completed delivery evidence from one trusted
 * GitHub snapshot. The caller must save only the returned state, never a
 * partially updated intermediate state.
 */
export function reconcilePostMergeEvidence(input: PostMergeReconciliationInput): RunState {
  const { snapshot } = input;
  const deliveryPullRequest = input.state.deliveryPullRequest ?? input.state.pullRequest;
  const expectedHead = (input.state.deliveryHeadSha ?? input.state.pullRequestHeadSha)?.toLowerCase();
  const observedHead = snapshot.headRefOid.toLowerCase();

  if (!deliveryPullRequest || deliveryPullRequest !== snapshot.number) {
    throw new Error(
      `run '${input.state.runId}' is bound to delivery PR #${deliveryPullRequest ?? "missing"}; refusing PR #${snapshot.number}`,
    );
  }
  if (!expectedHead || expectedHead !== observedHead) {
    throw new Error(
      `delivery PR #${snapshot.number} head ${observedHead} does not match bound head ${expectedHead ?? "missing"}`,
    );
  }
  if (snapshot.state !== "MERGED") {
    throw new Error(`delivery PR #${snapshot.number} is '${snapshot.state}', expected 'MERGED'`);
  }
  if (!snapshot.mergedAt || !snapshot.mergeCommit?.oid || !snapshot.mergedBy?.login) {
    throw new Error(`delivery PR #${snapshot.number} lacks complete GitHub merge metadata`);
  }
  if (snapshot.statusCheckRollup.length === 0) {
    throw new Error(`delivery PR #${snapshot.number} exposes no status-check evidence`);
  }
  const blockingChecks = findBlockingStatusChecks(snapshot.statusCheckRollup);
  if (blockingChecks.length > 0) {
    throw new Error(`delivery PR #${snapshot.number} has blocking checks: ${blockingChecks.join(", ")}`);
  }
  const openThreads = snapshot.reviewThreads.filter((thread) => !thread.isResolved && !thread.isOutdated);
  if (openThreads.length > 0) {
    throw new Error(
      `delivery PR #${snapshot.number} has ${openThreads.length} unresolved current review thread(s): ${openThreads.map((thread) => thread.id).join(", ")}`,
    );
  }
  const submittedReviews = snapshot.reviews.filter(
    (review) => !["DISMISSED", "PENDING"].includes(review.state.toUpperCase()),
  );
  if (submittedReviews.length === 0) {
    throw new Error(`delivery PR #${snapshot.number} exposes no submitted review evidence`);
  }

  assertExistingEvidenceMatches(input.state, observedHead);

  const uniqueEvidence = [...new Set(input.evidence)];
  let state = upsertGate(input.state, {
    id: POST_MERGE_RECONCILIATION_GATE,
    type: "runtime",
    question: `GitHub-verified post-merge evidence for PR #${snapshot.number} head ${observedHead}`,
  });
  if (!state.implementationEvidence) {
    state = recordDirectImplementationEvidence(state, {
      commitSha: observedHead,
      actor: input.actor,
      evidence: uniqueEvidence,
    });
  }
  if (!state.verificationEvidence) {
    state = recordVerificationEvidence(state, { headSha: observedHead, evidence: uniqueEvidence });
  }
  if (!state.reviewEvidence) {
    state = recordReviewEvidence(state, { headSha: observedHead, evidence: uniqueEvidence });
  }
  state = recordDeliveryMergeEffect(state, {
    pullRequest: snapshot.number,
    approvedHeadSha: observedHead,
    mergeCommitSha: snapshot.mergeCommit.oid,
    mergedAt: snapshot.mergedAt,
    mergedBy: snapshot.mergedBy.login,
    mergedByType: snapshot.mergedBy.__typename,
  });
  return state;
}

export function completePostMergeReconciliation(state: RunState, evidence: string[]): RunState {
  const gate = findGate(state, POST_MERGE_RECONCILIATION_GATE);
  if (!gate) throw new Error(`gate '${POST_MERGE_RECONCILIATION_GATE}' is missing`);
  if (gate.result === "passed") return state;
  return resolveGate(state, POST_MERGE_RECONCILIATION_GATE, {
    result: "passed",
    evidence: [...new Set([...(gate.evidence ?? []), ...evidence])],
  });
}

export function failPostMergeReconciliation(state: RunState, evidence: string[]): RunState {
  const completedGate = findGate(state, POST_MERGE_RECONCILIATION_GATE);
  if (
    completedGate?.result === "passed" &&
    completedGate.evidence?.some((item) => item.startsWith("audit-confirmed-at:"))
  ) {
    return state;
  }
  let working = upsertGate(state, {
    id: POST_MERGE_RECONCILIATION_GATE,
    type: "runtime",
    question: "GitHub-verified post-merge evidence reconciliation",
  });
  working = resolveGate(working, POST_MERGE_RECONCILIATION_GATE, {
    result: "failed",
    evidence: [...new Set(evidence)],
  });
  return working;
}

export function buildPostMergeAuditEnvelope(options: {
  state: RunState;
  trackingIssue: number;
  snapshot: PostMergePullRequestSnapshot;
  actor: string;
  accessRole: string;
  reason: string;
  description: string;
  evidence: string[];
}) {
  const head = options.snapshot.headRefOid.toLowerCase();
  return {
    schema_version: 1 as const,
    occurred_at: options.snapshot.mergedAt!,
    process_instance: formatCanonicalRunId(options.state.repository, options.trackingIssue).processInstance,
    idempotency_key: `post-merge-reconcile:${options.state.runId}:pr${options.snapshot.number}:${head}:v1`,
    process_code: "PROCESS_RECONCILIATION" as const,
    actor: options.actor,
    access_role: options.accessRole,
    supporting_access_roles: [] as string[],
    outcome: "SUCCEEDED",
    repository: options.state.repository,
    artifact: options.snapshot.mergeCommit!.oid!,
    correlation_ids: [options.state.runId, `ISSUE-${options.trackingIssue}`, `PR-${options.snapshot.number}`, head],
    evidence: [...new Set(options.evidence)],
    reason: options.reason,
    description: options.description,
  };
}
