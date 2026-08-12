/**
 * SPEC-009: Review-remediation orchestration helpers.
 *
 * These functions coordinate the full review-fix lifecycle described in
 * SPEC-009 (decisions 1-10):
 *   - build a review package from all new actionable threads for the exact PR/SHA,
 *   - classify each thread (pure, delegated to state-machine),
 *   - guard against loop, duplicate and bot-own events,
 *   - escalate to a human gate when conflicts, scope extensions, or the
 *     iteration cap are reached.
 *
 * All GitHub write actions are performed through named functions in
 * src/github/gh.ts — no ad-hoc gh/API calls here.
 */

import { nowIso } from "../state/store.js";
import {
  buildReviewIdempotencyKey,
  classifyReviewThread,
  detectSelfHosting,
  incrementReviewLoopCounter,
  isReviewIterationActive,
  isReviewThreadAlreadyProcessed,
  recordReview,
  reviewLoopCapReached,
  upsertGate,
  upsertReviewThread,
} from "../state/state-machine.js";
import type { ReviewRecord, ReviewThreadRecord, RunState } from "../state/types.js";

export interface ReviewEventInput {
  /** Submitting actor login */
  reviewerLogin: string;
  /** Actor type from GitHub: 'User' | 'Bot' | 'Organization' | 'Mannequin' */
  reviewerType: string;
  reviewId: number;
  /** GitHub review state: 'CHANGES_REQUESTED' | 'COMMENTED' | 'APPROVED' */
  reviewState: string;
  submittedAt: string;
  /** Full HEAD SHA that was reviewed */
  reviewedHeadSha: string;
  pullRequest: number;
  repository: string;
}

export interface ReviewThreadInput {
  threadId: string;
  isResolved: boolean;
  isOutdated: boolean;
  /** Login of the author of the first comment */
  authorLogin: string;
  /** GitHub type of the first comment author */
  authorType: string;
  body: string;
  /** reviewId this thread belongs to */
  reviewId: number;
}

export interface ReviewPackageResult {
  /** Updated state after processing the package */
  state: RunState;
  /** True when at least one actionable thread was found */
  hasActionable: boolean;
  /** True when a human gate was opened (conflict, scope extension, cap) */
  gateOpened: boolean;
  /** The idempotency keys of threads that were newly classified */
  classifiedKeys: string[];
}

/**
 * Process a pull_request_review.submitted event.
 *
 * Guards (all no-ops):
 * - Runs without a bound PR or SHA are rejected.
 * - Bot-own events are suppressed (loopProtected).
 * - Same reviewId already recorded → idempotent no-op.
 * - Active implementation iteration in progress → defer.
 * - Review-loop cap already reached → gate already open, no-op.
 *
 * For every new actionable thread a ReviewThreadRecord is added and
 * a human gate is opened if conflicts are detected.
 * SPEC-009, decisions 1-6 and TAC-04/05/09/10.
 */
export function processReviewEvent(
  state: RunState,
  event: ReviewEventInput,
  threads: ReviewThreadInput[],
  opts: {
    selfActorLogin: string;
    trustedActors: string[];
  },
): ReviewPackageResult {
  const noChange: ReviewPackageResult = {
    state,
    hasActionable: false,
    gateOpened: false,
    classifiedKeys: [],
  };

  // SPEC-009 TAC-04: we only process events for an explicitly bound PR/SHA.
  const boundPr = state.implementationPullRequest ?? state.pullRequest;
  const boundSha = state.implementationHeadSha ?? state.pullRequestHeadSha;
  if (!boundPr || !boundSha) return noChange;

  // Ignore events for a different PR.
  if (event.pullRequest !== boundPr) return noChange;

  // Ignore events for a different SHA (stale review on an already-superseded commit).
  if (event.reviewedHeadSha.toLowerCase() !== boundSha.toLowerCase()) return noChange;

  // SPEC-009 TAC-09: loop guard — bot-own review events must never start an iteration.
  const isBotOwn = event.reviewerLogin.toLowerCase() === opts.selfActorLogin.toLowerCase();

  const reviewRecord: ReviewRecord = {
    reviewId: event.reviewId,
    reviewer: event.reviewerLogin,
    reviewerType: event.reviewerType,
    submittedAt: event.submittedAt,
    state: event.reviewState.toUpperCase(),
    repository: event.repository,
    pullRequest: event.pullRequest,
    reviewedHeadSha: event.reviewedHeadSha.toLowerCase(),
    loopProtected: isBotOwn,
  };

  // Record the review (idempotent).
  let updated = recordReview(state, reviewRecord);

  if (isBotOwn) return { state: updated, hasActionable: false, gateOpened: false, classifiedKeys: [] };

  // SPEC-009 decision 2: only trusted actors may start an implementation iteration.
  const isReviewerTrusted = opts.trustedActors.some(
    (a) => a.toLowerCase() === event.reviewerLogin.toLowerCase(),
  );
  if (!isReviewerTrusted) {
    return { state: updated, hasActionable: false, gateOpened: false, classifiedKeys: [] };
  }

  // SPEC-009 TAC-09: duplicate event for same reviewId is a no-op (already recorded above).
  const alreadyRecorded = (state.reviews ?? []).some((r) => r.reviewId === event.reviewId);
  if (alreadyRecorded) return { state: updated, hasActionable: false, gateOpened: false, classifiedKeys: [] };

  // SPEC-009 decision 6: active iteration → defer; cap reached → no further action.
  if (isReviewIterationActive(updated)) return { state: updated, hasActionable: false, gateOpened: false, classifiedKeys: [] };
  if (reviewLoopCapReached(updated)) return { state: updated, hasActionable: false, gateOpened: false, classifiedKeys: [] };

  // Classify threads and build the package.
  const classifiedKeys: string[] = [];
  let hasActionable = false;
  let hasConflict = false;

  for (const thread of threads) {
    const idempotencyKey = buildReviewIdempotencyKey(
      event.repository,
      event.pullRequest,
      event.reviewId,
      thread.threadId,
      event.reviewedHeadSha,
    );

    // Already processed → skip.
    if (isReviewThreadAlreadyProcessed(updated, idempotencyKey)) continue;

    const status = classifyReviewThread({
      body: thread.body,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      authorLogin: thread.authorLogin,
      selfActorLogin: opts.selfActorLogin,
      trustedActors: opts.trustedActors,
    });

    const record: ReviewThreadRecord = {
      idempotencyKey,
      repository: event.repository,
      pullRequest: event.pullRequest,
      reviewId: event.reviewId,
      threadId: thread.threadId,
      reviewedHeadSha: event.reviewedHeadSha.toLowerCase(),
      reviewer: event.reviewerLogin,
      reviewerType: event.reviewerType,
      status,
      classifiedAt: nowIso(),
      auditedAt: nowIso(),
    };

    updated = upsertReviewThread(updated, record);
    classifiedKeys.push(idempotencyKey);

    if (status === "actionable") hasActionable = true;
    if (status === "conflicting") hasConflict = true;
  }

  // Open a human gate for conflicts (SPEC-009, decision 4 & TAC-10).
  let gateOpened = false;
  if (hasConflict) {
    const gateId = `review-conflict-pr${event.pullRequest}-sha${event.reviewedHeadSha.slice(0, 8)}`;
    updated = upsertGate(updated, {
      id: gateId,
      type: "human",
      question: `Review for PR #${event.pullRequest} (SHA ${event.reviewedHeadSha.slice(0, 8)}) contains conflicting or scope-extending threads. Human decision required before implementation.`,
      context: {
        scope: "Review conflict resolution",
        criteria: ["All conflicting threads are resolved or explicitly declined by a human."],
        risks: ["Conflicting review feedback may indicate competing product requirements."],
        followUpAction: "Apply harness:gate-approved or harness:gate-rejected label.",
      },
    });
    gateOpened = true;
  }

  return { state: updated, hasActionable, gateOpened, classifiedKeys };
}

/**
 * Record a failed review-fix iteration and open a human gate when the cap
 * is reached. SPEC-009, decision 6 & TAC-10.
 */
export function handleFailedReviewIteration(
  state: RunState,
  context: { pullRequest: number; headSha: string },
): RunState {
  let updated = incrementReviewLoopCounter(state);
  if (reviewLoopCapReached(updated)) {
    const gateId = `review-loop-cap-pr${context.pullRequest}`;
    updated = upsertGate(updated, {
      id: gateId,
      type: "human",
      question: `Automatic review-fix iteration limit (${state.maxAutomaticIterations}) reached for PR #${context.pullRequest}. Human intervention required.`,
      context: {
        scope: "Review-fix iteration cap escalation",
        criteria: ["A human decides whether to continue, re-scope, or close the run."],
        risks: ["Repeated automatic failures may indicate a fundamental implementation problem."],
        followUpAction: "Apply harness:gate-approved to allow a further manual attempt, or harness:gate-rejected to close.",
      },
    });
  }
  return updated;
}

/**
 * Guard for self-hosted bootstrap: validate that the chosen harness ref is a
 * published immutable ref (release tag or full SHA), not a branch name.
 * Returns an error string when the ref is invalid, undefined when it is safe.
 * SPEC-009, TAC-02.
 */
export function validateSelfHostingRef(
  harnessSourceRepository: string,
  targetRepository: string,
  harnessRef: string,
): string | undefined {
  if (!detectSelfHosting(harnessSourceRepository, targetRepository)) return undefined;
  // A safe ref is either a semver tag (v1.2.3) or a full 40-char SHA.
  const isTag = /^v\d+\.\d+\.\d+$/.test(harnessRef);
  const isSha = /^[0-9a-f]{40}$/i.test(harnessRef);
  if (!isTag && !isSha) {
    return (
      `Self-hosting requires a published immutable ref (tag like v1.2.3 or full SHA). ` +
      `'${harnessRef}' looks like a branch name and is not allowed to prevent recursive bootstrap.`
    );
  }
  return undefined;
}
