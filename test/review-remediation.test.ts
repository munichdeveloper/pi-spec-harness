/**
 * SPEC-009: Review-remediation unit, workflow-contract, and synthetic E2E tests.
 *
 * Covers all technical acceptance criteria:
 * TAC-04 – actionable review starts exactly one iteration per PR/SHA
 * TAC-05 – informational, outdated, resolved, untrusted and duplicate events are no-ops
 * TAC-06 – every thread gets an audited classification, reply and resolution decision
 * TAC-07 – thread resolution only after CI evidence; conflict threads stay open
 * TAC-08 – new HEAD SHA invalidates old SHA-bound evidence
 * TAC-09 – duplicate event delivery and bot-own events are idempotent no-ops
 * TAC-10 – conflicts and iteration cap open a structured human gate
 * TAC-11 – audit fields (actor, role, timestamp, PR, SHA) present on every record
 * TAC-12 – self-hosting ref validation rejects branch names
 * TAC-01/02 – self-hosting detection and immutable-ref guard
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildReviewIdempotencyKey,
  classifyReviewThread,
  detectSelfHosting,
  initRunState,
  invalidateReviewEvidenceForSha,
  isReviewIterationActive,
  isReviewThreadAlreadyProcessed,
  recordReview,
  reviewLoopCapReached,
  upsertReviewThread,
} from "../src/state/state-machine.js";
import {
  handleFailedReviewIteration,
  processReviewEvent,
  validateSelfHostingRef,
} from "../src/review/review-fix.js";
import type { ReviewRecord, ReviewThreadRecord, RunState } from "../src/state/types.js";
import {
  REVIEW_FIX_REFERENCE_MARKER,
  REVIEW_FIX_REFERENCE_PATH,
  renderReviewFixReference,
} from "../src/workflows/template-catalog.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha(char: string): string {
  return char.repeat(40);
}

function baseRun(overrides: Partial<Parameters<typeof initRunState>[0]> = {}): RunState {
  return initRunState({
    runId: "spec-009-test-001",
    repository: "munichdeveloper/pi-spec-harness",
    requirement: "REQ-009",
    spec: "SPEC-009",
    ...overrides,
  });
}

function boundRun(): RunState {
  let state = baseRun();
  // Simulate an implementation PR being bound
  state = {
    ...state,
    implementationPullRequest: 42,
    implementationHeadSha: sha("a"),
  };
  return state;
}

const TRUSTED_ACTORS = ["copilot-pull-request-reviewer", "trusted-human"];
const SELF_ACTOR = "github-actions[bot]";

const REVIEW_EVENT_DEFAULTS = {
  reviewerLogin: "copilot-pull-request-reviewer",
  reviewerType: "Bot",
  reviewId: 1001,
  reviewState: "changes_requested",
  submittedAt: "2026-08-12T10:00:00Z",
  reviewedHeadSha: sha("a"),
  pullRequest: 42,
  repository: "munichdeveloper/pi-spec-harness",
};

const THREAD_DEFAULTS = {
  threadId: "thread-001",
  isResolved: false,
  isOutdated: false,
  authorLogin: "copilot-pull-request-reviewer",
  authorType: "Bot",
  body: "Please rename this variable to be more descriptive.",
  reviewId: 1001,
};

// ---------------------------------------------------------------------------
// TAC-04 & TAC-05: Thread classification
// ---------------------------------------------------------------------------

describe("classifyReviewThread (TAC-05/TAC-06)", () => {
  const base = {
    body: "Please rename this variable.",
    isResolved: false,
    isOutdated: false,
    authorLogin: "copilot-pull-request-reviewer",
    selfActorLogin: SELF_ACTOR,
    trustedActors: TRUSTED_ACTORS,
  };

  it("classifies a normal trusted reviewer comment as actionable", () => {
    expect(classifyReviewThread(base)).toBe("actionable");
  });

  it("classifies a resolved thread as resolved (TAC-05)", () => {
    expect(classifyReviewThread({ ...base, isResolved: true })).toBe("resolved");
  });

  it("classifies an outdated thread as outdated (TAC-05)", () => {
    expect(classifyReviewThread({ ...base, isOutdated: true })).toBe("outdated");
  });

  it("classifies bot-own author as informational — loop guard (TAC-09)", () => {
    expect(classifyReviewThread({ ...base, authorLogin: SELF_ACTOR })).toBe("informational");
  });

  it("classifies an untrusted actor as informational (TAC-05)", () => {
    expect(classifyReviewThread({ ...base, authorLogin: "random-outsider" })).toBe("informational");
  });

  it("classifies a thread with conflict keywords as conflicting (TAC-10)", () => {
    const conflicting = classifyReviewThread({ ...base, body: "This changes auth permission handling." });
    expect(conflicting).toBe("conflicting");
  });

  it("classifies a thread mentioning secrets as conflicting (TAC-10)", () => {
    expect(classifyReviewThread({ ...base, body: "This leaks a secret value." })).toBe("conflicting");
  });

  it("resolved takes precedence over outdated (TAC-05)", () => {
    expect(classifyReviewThread({ ...base, isResolved: true, isOutdated: true })).toBe("resolved");
  });

  it("does not treat arbitrary characters between scope and erweiterung as conflicts", () => {
    expect(classifyReviewThread({ ...base, body: "scopeXerweiterung is an unrelated identifier" })).toBe("actionable");
  });
});

// ---------------------------------------------------------------------------
// TAC-11: buildReviewIdempotencyKey
// ---------------------------------------------------------------------------

describe("buildReviewIdempotencyKey (TAC-11)", () => {
  it("includes all five dimensions in the key", () => {
    const key = buildReviewIdempotencyKey("owner/repo", 7, 1001, "thread-001", sha("a"));
    expect(key).toContain("owner/repo");
    expect(key).toContain("pr7");
    expect(key).toContain("review1001");
    expect(key).toContain("thread-001");
    expect(key).toContain(`sha${sha("a")}`);
  });

  it("normalises SHA to lowercase", () => {
    const lower = buildReviewIdempotencyKey("r/r", 1, 1, "t", sha("a"));
    const upper = buildReviewIdempotencyKey("r/r", 1, 1, "t", sha("A"));
    expect(lower).toBe(upper);
  });

  it("normalises repository casing for cross-event deduplication", () => {
    const lower = buildReviewIdempotencyKey("owner/repo", 1, 1, "t", sha("a"));
    const mixed = buildReviewIdempotencyKey("Owner/Repo", 1, 1, "t", sha("a"));
    expect(mixed).toBe(lower);
  });

  it("produces distinct keys for different thread IDs", () => {
    const k1 = buildReviewIdempotencyKey("r/r", 1, 1, "thread-001", sha("a"));
    const k2 = buildReviewIdempotencyKey("r/r", 1, 1, "thread-002", sha("a"));
    expect(k1).not.toBe(k2);
  });

  it("produces distinct keys for different SHAs", () => {
    const k1 = buildReviewIdempotencyKey("r/r", 1, 1, "t", sha("a"));
    const k2 = buildReviewIdempotencyKey("r/r", 1, 1, "t", sha("b"));
    expect(k1).not.toBe(k2);
  });
});

// ---------------------------------------------------------------------------
// TAC-09: recordReview idempotency
// ---------------------------------------------------------------------------

describe("recordReview (TAC-09)", () => {
  it("records a new review", () => {
    const state = baseRun();
    const review: ReviewRecord = {
      reviewId: 1001,
      reviewer: "copilot-pull-request-reviewer",
      reviewerType: "Bot",
      submittedAt: "2026-08-12T10:00:00Z",
      state: "CHANGES_REQUESTED",
      repository: "munichdeveloper/pi-spec-harness",
      pullRequest: 42,
      reviewedHeadSha: sha("a"),
    };
    const updated = recordReview(state, review);
    expect(updated.reviews).toHaveLength(1);
  });

  it("is idempotent for the same reviewId", () => {
    let state = baseRun();
    const review: ReviewRecord = {
      reviewId: 1001,
      reviewer: "copilot-pull-request-reviewer",
      reviewerType: "Bot",
      submittedAt: "2026-08-12T10:00:00Z",
      state: "CHANGES_REQUESTED",
      repository: "munichdeveloper/pi-spec-harness",
      pullRequest: 42,
      reviewedHeadSha: sha("a"),
    };
    state = recordReview(state, review);
    const again = recordReview(state, review);
    expect(again.reviews).toHaveLength(1);
    expect(again).toBe(state); // same object reference — truly idempotent
  });
});

// ---------------------------------------------------------------------------
// TAC-09: upsertReviewThread idempotency
// ---------------------------------------------------------------------------

describe("upsertReviewThread (TAC-09)", () => {
  it("adds a new thread record", () => {
    const state = baseRun();
    const key = buildReviewIdempotencyKey("r/r", 1, 1, "t1", sha("a"));
    const thread: ReviewThreadRecord = {
      idempotencyKey: key,
      repository: "r/r",
      pullRequest: 1,
      reviewId: 1,
      threadId: "t1",
      reviewedHeadSha: sha("a"),
      reviewer: "reviewer",
      reviewerType: "User",
      status: "actionable",
      auditedAt: new Date().toISOString(),
    };
    const updated = upsertReviewThread(state, thread);
    expect(updated.reviewThreads).toHaveLength(1);
  });

  it("is idempotent for the same idempotency key", () => {
    let state = baseRun();
    const key = buildReviewIdempotencyKey("r/r", 1, 1, "t1", sha("a"));
    const thread: ReviewThreadRecord = {
      idempotencyKey: key,
      repository: "r/r",
      pullRequest: 1,
      reviewId: 1,
      threadId: "t1",
      reviewedHeadSha: sha("a"),
      reviewer: "reviewer",
      reviewerType: "User",
      status: "actionable",
      auditedAt: new Date().toISOString(),
    };
    state = upsertReviewThread(state, thread);
    const again = upsertReviewThread(state, thread);
    expect(again.reviewThreads).toHaveLength(1);
    expect(again).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// TAC-09: isReviewThreadAlreadyProcessed
// ---------------------------------------------------------------------------

describe("isReviewThreadAlreadyProcessed (TAC-09)", () => {
  it("returns false when thread is absent", () => {
    const state = baseRun();
    expect(isReviewThreadAlreadyProcessed(state, "unknown-key")).toBe(false);
  });

  it("returns true when the key is already present", () => {
    let state = baseRun();
    const key = buildReviewIdempotencyKey("r/r", 1, 1, "t1", sha("a"));
    const thread: ReviewThreadRecord = {
      idempotencyKey: key,
      repository: "r/r",
      pullRequest: 1,
      reviewId: 1,
      threadId: "t1",
      reviewedHeadSha: sha("a"),
      reviewer: "reviewer",
      reviewerType: "User",
      status: "actionable",
      auditedAt: new Date().toISOString(),
    };
    state = upsertReviewThread(state, thread);
    expect(isReviewThreadAlreadyProcessed(state, key)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TAC-08: invalidateReviewEvidenceForSha
// ---------------------------------------------------------------------------

describe("invalidateReviewEvidenceForSha (TAC-08)", () => {
  it("marks threads with the old SHA as outdated", () => {
    let state = baseRun();
    const key = buildReviewIdempotencyKey("r/r", 1, 1, "t1", sha("a"));
    const thread: ReviewThreadRecord = {
      idempotencyKey: key,
      repository: "r/r",
      pullRequest: 1,
      reviewId: 1,
      threadId: "t1",
      reviewedHeadSha: sha("a"),
      reviewer: "reviewer",
      reviewerType: "User",
      status: "actionable",
      auditedAt: new Date().toISOString(),
    };
    state = upsertReviewThread(state, thread);
    const invalidated = invalidateReviewEvidenceForSha(state, sha("a"));
    expect(invalidated.reviewThreads![0].status).toBe("outdated");
  });

  it("normalizes a stored uppercase SHA before invalidation", () => {
    let state = baseRun();
    const key = buildReviewIdempotencyKey("r/r", 1, 1, "t1", sha("a"));
    state = upsertReviewThread(state, {
      idempotencyKey: key,
      repository: "r/r",
      pullRequest: 1,
      reviewId: 1,
      threadId: "t1",
      reviewedHeadSha: sha("a").toUpperCase(),
      reviewer: "reviewer",
      reviewerType: "User",
      status: "actionable",
      auditedAt: new Date().toISOString(),
    });

    const invalidated = invalidateReviewEvidenceForSha(state, sha("a"));
    expect(invalidated.reviewThreads![0].status).toBe("outdated");
  });

  it("does not touch threads for a different SHA", () => {
    let state = baseRun();
    const key = buildReviewIdempotencyKey("r/r", 1, 1, "t1", sha("b"));
    const thread: ReviewThreadRecord = {
      idempotencyKey: key,
      repository: "r/r",
      pullRequest: 1,
      reviewId: 1,
      threadId: "t1",
      reviewedHeadSha: sha("b"),
      reviewer: "reviewer",
      reviewerType: "User",
      status: "actionable",
      auditedAt: new Date().toISOString(),
    };
    state = upsertReviewThread(state, thread);
    const invalidated = invalidateReviewEvidenceForSha(state, sha("a"));
    expect(invalidated.reviewThreads![0].status).toBe("actionable"); // unchanged
  });

  it("preserves already-resolved threads (TAC-07)", () => {
    let state = baseRun();
    const key = buildReviewIdempotencyKey("r/r", 1, 1, "t1", sha("a"));
    const thread: ReviewThreadRecord = {
      idempotencyKey: key,
      repository: "r/r",
      pullRequest: 1,
      reviewId: 1,
      threadId: "t1",
      reviewedHeadSha: sha("a"),
      reviewer: "reviewer",
      reviewerType: "User",
      status: "resolved",
      auditedAt: new Date().toISOString(),
    };
    state = upsertReviewThread(state, thread);
    const invalidated = invalidateReviewEvidenceForSha(state, sha("a"));
    expect(invalidated.reviewThreads![0].status).toBe("resolved");
  });
});

// ---------------------------------------------------------------------------
// TAC-06: isReviewIterationActive
// ---------------------------------------------------------------------------

describe("isReviewIterationActive (TAC-06)", () => {
  it("returns false when there are no threads", () => {
    expect(isReviewIterationActive(baseRun())).toBe(false);
  });

  it("returns true when a thread is implementing", () => {
    let state = baseRun();
    const key = buildReviewIdempotencyKey("r/r", 1, 1, "t1", sha("a"));
    const thread: ReviewThreadRecord = {
      idempotencyKey: key,
      repository: "r/r",
      pullRequest: 1,
      reviewId: 1,
      threadId: "t1",
      reviewedHeadSha: sha("a"),
      reviewer: "reviewer",
      reviewerType: "User",
      status: "implementing",
      auditedAt: new Date().toISOString(),
    };
    state = upsertReviewThread(state, thread);
    expect(isReviewIterationActive(state)).toBe(true);
  });

  it("returns false when all threads are implemented", () => {
    let state = baseRun();
    const key = buildReviewIdempotencyKey("r/r", 1, 1, "t1", sha("a"));
    const thread: ReviewThreadRecord = {
      idempotencyKey: key,
      repository: "r/r",
      pullRequest: 1,
      reviewId: 1,
      threadId: "t1",
      reviewedHeadSha: sha("a"),
      reviewer: "reviewer",
      reviewerType: "User",
      status: "implemented",
      auditedAt: new Date().toISOString(),
    };
    state = upsertReviewThread(state, thread);
    expect(isReviewIterationActive(state)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TAC-10: reviewLoopCapReached
// ---------------------------------------------------------------------------

describe("reviewLoopCapReached (TAC-10)", () => {
  it("returns false when counter is zero", () => {
    expect(reviewLoopCapReached(baseRun())).toBe(false);
  });

  it("returns true once counter equals maxAutomaticIterations", () => {
    let state = baseRun();
    for (let i = 0; i < state.maxAutomaticIterations; i++) {
      state = handleFailedReviewIteration(state, { pullRequest: 42, headSha: sha("a") });
    }
    expect(reviewLoopCapReached(state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TAC-10: handleFailedReviewIteration opens a human gate at the cap
// ---------------------------------------------------------------------------

describe("handleFailedReviewIteration (TAC-10)", () => {
  it("increments the review loop counter", () => {
    const state = baseRun();
    const updated = handleFailedReviewIteration(state, { pullRequest: 42, headSha: sha("a") });
    expect(updated.reviewLoopCounter).toBe(1);
  });

  it("opens a human gate when the cap is reached", () => {
    let state = baseRun();
    for (let i = 0; i < state.maxAutomaticIterations; i++) {
      state = handleFailedReviewIteration(state, { pullRequest: 42, headSha: sha("a") });
    }
    const gateOpened = state.gates.some((g) => g.id.startsWith("review-loop-cap-"));
    expect(gateOpened).toBe(true);
    const gate = state.gates.find((g) => g.id.startsWith("review-loop-cap-"))!;
    expect(gate.type).toBe("human");
    expect(gate.result).toBe("pending");
  });

  it("does not open a duplicate gate when cap is already open", () => {
    let state = baseRun();
    for (let i = 0; i < state.maxAutomaticIterations; i++) {
      state = handleFailedReviewIteration(state, { pullRequest: 42, headSha: sha("a") });
    }
    // One more call should not add another gate.
    state = handleFailedReviewIteration(state, { pullRequest: 42, headSha: sha("a") });
    const capGates = state.gates.filter((g) => g.id.startsWith("review-loop-cap-"));
    expect(capGates).toHaveLength(1); // idempotent gate upsert
  });
});

// ---------------------------------------------------------------------------
// TAC-04/TAC-09: processReviewEvent — full lifecycle
// ---------------------------------------------------------------------------

describe("processReviewEvent (TAC-04/TAC-05/TAC-09)", () => {
  const opts = { selfActorLogin: SELF_ACTOR, trustedActors: TRUSTED_ACTORS };

  it("TAC-04: actionable thread produces hasActionable=true", () => {
    const state = boundRun();
    const result = processReviewEvent(state, REVIEW_EVENT_DEFAULTS, [THREAD_DEFAULTS], opts);
    expect(result.hasActionable).toBe(true);
    expect(result.classifiedKeys).toHaveLength(1);
  });

  it("normalizes the persisted GitHub review state", () => {
    const result = processReviewEvent(boundRun(), REVIEW_EVENT_DEFAULTS, [THREAD_DEFAULTS], opts);
    expect(result.state.reviews?.[0].state).toBe("CHANGES_REQUESTED");
  });

  it("TAC-05: informational-only threads produce hasActionable=false", () => {
    const state = boundRun();
    const result = processReviewEvent(
      state,
      REVIEW_EVENT_DEFAULTS,
      [{ ...THREAD_DEFAULTS, isResolved: true }],
      opts,
    );
    expect(result.hasActionable).toBe(false);
  });

  it("TAC-05: untrusted reviewer's threads are informational", () => {
    const state = boundRun();
    const result = processReviewEvent(
      state,
      { ...REVIEW_EVENT_DEFAULTS, reviewerLogin: "random-outsider" },
      [THREAD_DEFAULTS],
      opts,
    );
    expect(result.hasActionable).toBe(false);
  });

  it("TAC-09: duplicate review event (same reviewId) is a no-op after first call", () => {
    let state = boundRun();
    const result1 = processReviewEvent(state, REVIEW_EVENT_DEFAULTS, [THREAD_DEFAULTS], opts);
    state = result1.state;
    // Second delivery of the same event — already recorded
    const result2 = processReviewEvent(state, REVIEW_EVENT_DEFAULTS, [THREAD_DEFAULTS], opts);
    expect(result2.classifiedKeys).toHaveLength(0);
    expect(result2.hasActionable).toBe(false);
  });

  it("TAC-09: bot-own event is loop-guarded", () => {
    const state = boundRun();
    const result = processReviewEvent(
      state,
      { ...REVIEW_EVENT_DEFAULTS, reviewerLogin: SELF_ACTOR },
      [THREAD_DEFAULTS],
      opts,
    );
    expect(result.hasActionable).toBe(false);
    const review = result.state.reviews?.find((r) => r.reviewId === REVIEW_EVENT_DEFAULTS.reviewId);
    expect(review?.loopProtected).toBe(true);
  });

  it("TAC-09: event for a different SHA is ignored", () => {
    const state = boundRun(); // bound to sha("a")
    const result = processReviewEvent(
      state,
      { ...REVIEW_EVENT_DEFAULTS, reviewedHeadSha: sha("b") },
      [THREAD_DEFAULTS],
      opts,
    );
    expect(result.classifiedKeys).toHaveLength(0);
  });

  it("TAC-09: event for a different PR is ignored", () => {
    const state = boundRun(); // bound to PR 42
    const result = processReviewEvent(
      state,
      { ...REVIEW_EVENT_DEFAULTS, pullRequest: 99 },
      [THREAD_DEFAULTS],
      opts,
    );
    expect(result.classifiedKeys).toHaveLength(0);
  });

  it("TAC-10: conflicting thread opens a human gate", () => {
    const state = boundRun();
    const result = processReviewEvent(
      state,
      REVIEW_EVENT_DEFAULTS,
      [{ ...THREAD_DEFAULTS, body: "This changes auth permission handling." }],
      opts,
    );
    expect(result.gateOpened).toBe(true);
    const gate = result.state.gates.find((g) => g.id.startsWith("review-conflict-"));
    expect(gate?.type).toBe("human");
  });

  it("TAC-09: active iteration blocks new event", () => {
    let state = boundRun();
    // Put an 'implementing' thread in the state
    const key = buildReviewIdempotencyKey(
      state.repository,
      42,
      1000,
      "prior-thread",
      sha("a"),
    );
    const thread: ReviewThreadRecord = {
      idempotencyKey: key,
      repository: state.repository,
      pullRequest: 42,
      reviewId: 1000,
      threadId: "prior-thread",
      reviewedHeadSha: sha("a"),
      reviewer: "reviewer",
      reviewerType: "User",
      status: "implementing",
      auditedAt: new Date().toISOString(),
    };
    state = upsertReviewThread(state, thread);
    const result = processReviewEvent(state, REVIEW_EVENT_DEFAULTS, [THREAD_DEFAULTS], opts);
    expect(result.classifiedKeys).toHaveLength(0);
  });

  it("TAC-04: run without a bound PR is ignored", () => {
    const state = baseRun(); // no implementationPullRequest
    const result = processReviewEvent(state, REVIEW_EVENT_DEFAULTS, [THREAD_DEFAULTS], opts);
    expect(result.classifiedKeys).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TAC-01/TAC-02: Self-hosting detection and ref validation
// ---------------------------------------------------------------------------

describe("detectSelfHosting (TAC-01/TAC-02)", () => {
  it("returns true when source and target repositories are identical", () => {
    expect(detectSelfHosting("munichdeveloper/pi-spec-harness", "munichdeveloper/pi-spec-harness")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(detectSelfHosting("Owner/Repo", "owner/repo")).toBe(true);
  });

  it("returns false when repositories differ", () => {
    expect(detectSelfHosting("munichdeveloper/pi-spec-harness", "munichdeveloper/Immogent")).toBe(false);
  });
});

describe("validateSelfHostingRef (TAC-02)", () => {
  const src = "munichdeveloper/pi-spec-harness";
  const target = "munichdeveloper/pi-spec-harness";

  it("accepts a semver tag", () => {
    expect(validateSelfHostingRef(src, target, "v1.2.3")).toBeUndefined();
  });

  it("accepts a full 40-char SHA", () => {
    expect(validateSelfHostingRef(src, target, sha("a"))).toBeUndefined();
  });

  it("rejects a branch name", () => {
    const err = validateSelfHostingRef(src, target, "main");
    expect(err).toMatch(/branch name/i);
  });

  it("rejects an unmerged feature branch", () => {
    const err = validateSelfHostingRef(src, target, "feat/spec-009");
    expect(err).toMatch(/immutable ref/i);
  });

  it("rejects a branch-style ref with a semver prefix", () => {
    const err = validateSelfHostingRef(src, target, "v1.2.3/feature");
    expect(err).toMatch(/immutable ref/i);
  });

  it("returns undefined for a non-self-hosting setup", () => {
    expect(validateSelfHostingRef(src, "munichdeveloper/Immogent", "main")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TAC-12: Review-fix workflow template
// ---------------------------------------------------------------------------

describe("renderReviewFixReference (TAC-12)", () => {
  it("contains the managed marker", () => {
    const content = renderReviewFixReference();
    expect(content).toContain(REVIEW_FIX_REFERENCE_MARKER);
  });

  it("triggers on pull_request_review submitted", () => {
    const content = renderReviewFixReference();
    expect(content).toContain("pull_request_review:");
    expect(content).toContain("types: [submitted]");
  });

  it("triggers on pull_request_review_thread resolved/unresolved", () => {
    const content = renderReviewFixReference();
    expect(content).toContain("pull_request_review_thread:");
    expect(content).toContain("resolved, unresolved");
  });

  it("uses cancel-in-progress: false to prevent overholding races (SPEC-009 decision 1)", () => {
    const content = renderReviewFixReference();
    expect(content).toContain("cancel-in-progress: false");
  });

  it("references the harness reusable workflow at the given ref", () => {
    const content = renderReviewFixReference({ harnessRef: "v1.0.0" });
    expect(content).toContain("/.github/workflows/review-fix.yml@v1.0.0");
  });

  it("uses the pull request payload consistently for concurrency", () => {
    const content = renderReviewFixReference();
    expect(content).toContain("github.event.pull_request.number");
    expect(content).not.toContain("github.event.thread.pull_request.number");
  });

  it("exposes pull-requests write permission", () => {
    const content = renderReviewFixReference();
    expect(content).toContain("pull-requests: write");
  });
});

// ---------------------------------------------------------------------------
// TAC-12: Workflow template catalog includes review-fix
// ---------------------------------------------------------------------------

describe("workflow template catalog (TAC-12)", () => {
  it("REVIEW_FIX_REFERENCE_PATH is a valid .yml path", () => {
    expect(REVIEW_FIX_REFERENCE_PATH).toMatch(/\.ya?ml$/);
    expect(REVIEW_FIX_REFERENCE_PATH).toContain("review");
  });
});

// ---------------------------------------------------------------------------
// TAC-12: Workflow contract — harness-gate-trigger has review-fix job
// ---------------------------------------------------------------------------

describe("GitHub workflow contract — review-fix job (TAC-12)", () => {
  it("harness-gate-trigger defines a review-fix job for pull_request_review.submitted", async () => {
    const workflow = await readFile(".github/workflows/harness-gate-trigger.yml", "utf8");
    expect(workflow).toContain("pull_request_review:");
    expect(workflow).toContain("types: [submitted]");
    expect(workflow).toContain("review-fix:");
    expect(workflow).toContain("changes_requested");
    expect(workflow).toContain("harness-review-fix-");
    // SPEC-009 TAC-02: trusted-actors configuration
    expect(workflow).toContain("HARNESS_TRUSTED_REVIEW_ACTORS");
    // SPEC-009 decision 7: agent selector
    expect(workflow).toContain("HARNESS_REVIEW_FIX_AGENT");
    // SPEC-009 decision 1: concurrency serialisation
    expect(workflow).toContain("cancel-in-progress: false");
    // SPEC-009: must not use newest-issue selection
    expect(workflow).not.toContain("sort -V");
    expect(workflow).not.toContain("tail -1");
    // SPEC-009 TAC-09: deduplication via harness CLI
    expect(workflow).toContain("review-fix");
    expect(workflow).toContain("actions/checkout@v4");
  });

  it("review-fix job requests pull-requests write permission (SPEC-009 TAC-11)", async () => {
    const workflow = await readFile(".github/workflows/harness-gate-trigger.yml", "utf8");
    expect(workflow).toContain("pull-requests: write");
  });

  it("review-fix reads trusted harness code from the default branch", async () => {
    const workflow = await readFile(".github/workflows/harness-gate-trigger.yml", "utf8");
    expect(workflow).toContain("ref: ${{ github.event.repository.default_branch }}");
  });

  it("binds processing to the commit reviewed by GitHub", async () => {
    const workflow = await readFile(".github/workflows/harness-gate-trigger.yml", "utf8");
    expect(workflow).toContain('head_sha="${{ github.event.review.commit_id }}"');
  });

  it("ships a callable reusable review-fix workflow", async () => {
    const workflow = await readFile(".github/workflows/review-fix.yml", "utf8");
    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain("npm run harness -- review-fix");
    expect(workflow).toContain("ref: ${{ inputs.harness-ref }}");
  });

  it("registers the review-fix CLI command", async () => {
    const cli = await readFile("src/cli.ts", "utf8");
    expect(cli).toContain('"review-fix"');
    expect(cli).toContain("cmdReviewFix");
    expect(cli).toContain("selfActorLogin: argv.selfActorLogin");
    expect(cli).toContain("@copilot");
    expect(cli).toContain('skipped: "unmanaged-pull-request"');
    expect(cli).toContain("comment?.author?.login");
    expect(cli).toContain("hasOpenHumanGate");
    expect(cli).toContain("Dispatched the configured review-fix agent");
  });

  it("enforces immutable refs during self-hosted init", async () => {
    const cli = await readFile("src/cli.ts", "utf8");
    expect(cli).toContain("validateSelfHostingRef(sourceRepository, argv.repository, harnessRef)");
  });
});

// ---------------------------------------------------------------------------
// TAC-12: gh.ts exposes named review functions
// ---------------------------------------------------------------------------

describe("named GitHub review functions (TAC-11/TAC-12)", () => {
  it("gh.ts exports listPullRequestReviews, listPullRequestReviewThreads, replyToReviewThread, resolveReviewThread", async () => {
    const gh = await readFile("src/github/gh.ts", "utf8");
    expect(gh).toContain("listPullRequestReviews");
    expect(gh).toContain("listPullRequestReviewThreads");
    expect(gh).toContain("replyToReviewThread");
    expect(gh).toContain("resolveReviewThread");
    expect(gh).toContain("comments(first: 1)");
    expect(gh).toContain("pullRequestReview { databaseId }");
    expect(gh).toContain("pulls/comments/${commentId}/replies");
    expect(gh).not.toContain("pulls/${prNumber}/comments/${commentId}/replies");
    // Must use named, auditable functions — no generic escape hatch
    expect(gh).not.toContain('"run arbitrary"');
  });

  it("resolveReviewThread uses the GraphQL resolveReviewThread mutation (TAC-07)", async () => {
    const gh = await readFile("src/github/gh.ts", "utf8");
    expect(gh).toContain("resolveReviewThread(input:");
    expect(gh).toContain("graphql");
  });
});

// ---------------------------------------------------------------------------
// TAC-12: review-fix module exports the key functions
// ---------------------------------------------------------------------------

describe("review-fix module exports (TAC-12)", () => {
  it("processReviewEvent is exported", () => {
    expect(typeof processReviewEvent).toBe("function");
  });

  it("handleFailedReviewIteration is exported", () => {
    expect(typeof handleFailedReviewIteration).toBe("function");
  });

  it("validateSelfHostingRef is exported", () => {
    expect(typeof validateSelfHostingRef).toBe("function");
  });
});
