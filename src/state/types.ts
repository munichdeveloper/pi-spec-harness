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

export interface RunState {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  repository: string; // "owner/repo", the reference/target product repo (e.g. munichdeveloper/Immogent)
  requirement: string; // stable requirement id, e.g. REQ-001
  spec: string; // stable spec id, e.g. SPEC-011
  issue?: number; // GitHub issue number once created
  branch?: string;
  pullRequest?: number;
  pullRequestHeadSha?: string;
  phase: PhaseId;
  createdAt: string;
  updatedAt: string;
  gates: GateRecord[];
  iterations: IterationRecord[];
  /** Hard iteration cap before a run must escalate to needs-human. */
  maxAutomaticIterations: number;
  notes?: string[];
}

export interface CommandResult<TResult = unknown> {
  schemaVersion: typeof SCHEMA_VERSION;
  command: string;
  result: TResult;
  nextAction: string;
}
