/**
 * Core run-state types for the Pi-native spec-driven harness.
 *
 * A "run" tracks one slice of work (usually one GitHub Issue derived from one
 * approved Software Spec) through the workflow phases described in
 * docs/workflow.md. Unlike the reference harness this repo is modeled after,
 * this harness is allowed to both bookkeep AND drive real GitHub write
 * actions (issues, comments, labels, PRs) -- but only through the adapter in
 * src/github, never ad hoc.
 */

export const SCHEMA_VERSION = 1 as const;

export type PhaseId =
  | "requirement"
  | "spec"
  | "issue"
  | "implementation"
  | "verification"
  | "iteration"
  | "documentation"
  | "merge"
  | "complete";

export type GateResult = "pending" | "passed" | "failed" | "needs-human";

export type GateType = "spec" | "issue" | "runtime" | "review" | "human" | "merge";

/**
 * A human gate is always backed by a GitHub Issue in the target repository.
 * This is the single, explicit place where a run stops and asks a human for
 * a decision -- deliberately separate from any chat transcript.
 */
export interface HumanGateIssueRef {
  repository: string; // "owner/repo"
  number: number;
  url: string;
}

/**
 * Structured decision context stored on a human gate. Rendered in the
 * tracking-issue body so a Product Owner can make an informed decision.
 */
export interface GateDecisionContext {
  scope?: string;
  criteria?: string[];
  risks?: string[];
  nonGoals?: string[];
  followUpAction?: string;
}

export interface GatePublication {
  status: "prepared" | "publishing" | "open";
  /** Stable marker used to make the externally visible gate comment idempotent. */
  marker: string;
  title: string;
  legacyContext: string[];
}

export interface GateRecord {
  id: string; // e.g. "spec-approval", "merge-slice-1"
  type: GateType;
  result: GateResult;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  /**
   * ISO timestamp recorded when the gate was published and became decidable.
   * Label-timeline events before this time are ignored (TAC-04/TAC-05).
   */
  openedAt?: string;
  /** Free-form question/context shown to the human, required for type "human". */
  question?: string;
  /** Structured decision context rendered in the tracking-issue body (TAC-01/TAC-02). */
  context?: GateDecisionContext;
  /** Durable publication checkpoint. `prepared` is persisted before GitHub writes. */
  publication?: GatePublication;
  /** Set with the canonical decision and cleared only after idempotent side-effects succeed. */
  cleanupPending?: boolean;
  /** Present once a human gate issue has been opened. */
  issue?: HumanGateIssueRef;
  /** Evidence supporting a passed/failed result (URLs, file paths, check run ids). */
  evidence?: string[];
  /** Set once a human gate has been resolved. */
  decision?: {
    approved: boolean;
    by: string;
    at: string;
    note?: string;
  };
}

export interface IterationRecord {
  index: number; // 1-based
  startedAt: string;
  finishedAt?: string;
  result?: "passed" | "failed";
  findings?: string[];
}

/**
 * Lifecycle status for a single review thread.
 * SPEC-009, decision 3.
 */
export type ReviewThreadStatus =
  | "pending"
  | "informational"
  | "actionable"
  | "implementing"
  | "implemented"
  | "declined"
  | "conflicting"
  | "needs-human"
  | "outdated"
  | "resolved";

/**
 * Persisted record for one review thread.
 * The idempotency key (repository + pullRequest + reviewId + threadId +
 * reviewedHeadSha) prevents duplicate or recursive processing.
 * SPEC-009, decision 3.
 */
export interface ReviewThreadRecord {
  /** Idempotency key: `${repository}:pr${pullRequest}:review${reviewId}:thread${threadId}:sha${reviewedHeadSha}` */
  idempotencyKey: string;
  repository: string;
  pullRequest: number;
  reviewId: number;
  threadId: string;
  reviewedHeadSha: string;
  reviewer: string;
  /** 'User' | 'Bot' | 'Organization' | 'Mannequin' */
  reviewerType: string;
  status: ReviewThreadStatus;
  /** 1-based iteration this thread is part of */
  iterationIndex?: number;
  /** Commit SHA produced while implementing this thread */
  implementedSha?: string;
  /** Reply text posted back to the thread on GitHub */
  reply?: string;
  /** ISO timestamp when the thread was resolved on GitHub */
  resolvedAt?: string;
  /** Reason stored for non-implementation decisions */
  declineReason?: string;
  classifiedAt?: string;
  auditedAt: string;
}

/**
 * Persisted record for one submitted review event.
 * SPEC-009, decision 3.
 */
export interface ReviewRecord {
  reviewId: number;
  reviewer: string;
  /** 'User' | 'Bot' | 'Organization' | 'Mannequin' */
  reviewerType: string;
  submittedAt: string;
  /** GitHub review state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' */
  state: string;
  repository: string;
  pullRequest: number;
  reviewedHeadSha: string;
  processedAt?: string;
  iterationIndex?: number;
  /** True when suppressed as a bot-own or duplicate event (loop guard). */
  loopProtected?: boolean;
}

/**
 * Canonical run identity derived from the persistent tracking-issue number.
 * SPEC-012, decision 1 / TAC-01.
 */
export interface CanonicalRunId {
  /** e.g. "RUN-0056" — zero-padded to at least four digits. */
  runId: string;
  /** e.g. "munichdeveloper/pi-spec-harness#RUN-0056" */
  qualifiedRunId: string;
  /** e.g. "PI-MUNICHDEVELOPER-PI-SPEC-HARNESS-RUN-0056" */
  processInstance: string;
}

/**
 * Lifecycle checkpoint for the run-documentation snapshot.
 * Persisted before any external write so that every retry can reproduce
 * the same byte-identical content. SPEC-012, decision 2.
 */
export interface DocumentationSnapshotCheckpoint {
  schemaVersion: 1;
  status: "prepared" | "publishing" | "persisted";
  /** Stable idempotency key for the write operation. */
  idempotencyKey: string;
  /** Relative path of the generated snapshot (relative to repo root). */
  path: string;
  /** Relative path of the run index document. */
  indexPath: string;
  /** Relative path of the Obsidian base document. */
  obsidianBasePath: string;
  /** ISO timestamp when the checkpoint was prepared. */
  generatedAt: string;
  /** HEAD SHA of the source branch used to render the snapshot. */
  sourceHeadSha: string;
  /** SHA of the documentation commit once the push is confirmed. */
  commitSha?: string;
  /** Idempotency key for the follow-up audit event (REQ-005). */
  auditIdempotencyKey: string;
  /** ISO timestamp recorded once the audit event is confirmed. */
  auditConfirmedAt?: string;
  /**
   * Number of write-or-audit delivery attempts that have failed so far.
   * Used by the reconciler to open exactly one `run-documentation-delivery-failed`
   * Human Gate after three failures. SPEC-012, decision 9 / TAC-13.
   */
  deliveryFailureCount?: number;
}

export interface RunState {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  repository: string; // "owner/repo", the reference/target product repo (e.g. munichdeveloper/Immogent)
  requirement: string; // stable requirement id, e.g. REQ-001
  spec: string; // stable spec id, e.g. SPEC-011
  issue?: number; // GitHub issue number once created
  branch?: string;
  /** @deprecated Use deliveryPullRequest / deliveryHeadSha instead for new runs. Kept for backward compatibility. */
  pullRequest?: number;
  /** @deprecated Use deliveryPullRequest / deliveryHeadSha instead for new runs. Kept for backward compatibility. */
  pullRequestHeadSha?: string;
  /**
   * Delivery PR (against the default branch, human-managed).
   * TAC-01: tracked separately from the implementation PR.
   */
  deliveryPullRequest?: number;
  /** Full HEAD SHA of the delivery branch at the last verified checkpoint. */
  deliveryHeadSha?: string;
  /** Merge commit persisted after GitHub confirms the delivery PR was merged. */
  deliveryMergeCommitSha?: string;
  /** Timestamp persisted with the verified delivery PR merge effect. */
  deliveryMergedAt?: string;
  /**
   * Implementation PR created by the Coding Agent against the delivery branch.
   * TAC-01: tracked separately from the delivery PR.
   */
  implementationPullRequest?: number;
  /** Full HEAD SHA of the implementation PR at the last verified checkpoint. */
  implementationHeadSha?: string;
  /**
   * Explicit path to the bound requirement document (relative to repo root).
   * TAC-01: set at run start; glob / "newest file" selection is forbidden.
   */
  requirementPath?: string;
  /**
   * Explicit path to the bound software-spec document (relative to repo root).
   * TAC-01: set at run start; glob / "newest file" selection is forbidden.
   */
  specPath?: string;
  phase: PhaseId;
  createdAt: string;
  updatedAt: string;
  gates: GateRecord[];
  iterations: IterationRecord[];
  /** Hard iteration cap before a run must escalate to needs-human. */
  maxAutomaticIterations: number;
  notes?: string[];
  /**
   * Persisted log of submitted reviews processed for this run.
   * SPEC-009, decision 3.
   */
  reviews?: ReviewRecord[];
  /**
   * Persisted log of individual review threads classified and acted upon.
   * SPEC-009, decision 3.
   */
  reviewThreads?: ReviewThreadRecord[];
  /**
   * Counter of failed automatic review-fix iterations for this run.
   * Separate from the general iteration counter so the cap can be applied
   * independently. SPEC-009, decision 6.
   */
  reviewLoopCounter?: number;
  /**
   * Checkpoint tracking the post-merge documentation snapshot lifecycle.
   * Optional and rückwärtskompatibel; absent for runs created before SPEC-012.
   * SPEC-012, decision 2.
   */
  documentationSnapshot?: DocumentationSnapshotCheckpoint;
}

export interface CommandResult<TResult = unknown> {
  schemaVersion: typeof SCHEMA_VERSION;
  command: string;
  result: TResult;
  nextAction: string;
}
