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

export interface GateRecord {
  id: string; // e.g. "spec-approval", "merge-slice-1"
  type: GateType;
  result: GateResult;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  /** Free-form question/context shown to the human, required for type "human". */
  question?: string;
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
}

export interface CommandResult<TResult = unknown> {
  schemaVersion: typeof SCHEMA_VERSION;
  command: string;
  result: TResult;
  nextAction: string;
}
