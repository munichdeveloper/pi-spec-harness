import { nowIso } from "./store.js";
import type { CanonicalRunId, GateDecisionContext, GateRecord, GateResult, GateType, IterationRecord, PhaseId, ReviewRecord, ReviewThreadRecord, ReviewThreadStatus, RunState } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export const PHASE_ORDER: PhaseId[] = [
  "requirement",
  "spec",
  "issue",
  "implementation",
  "verification",
  "iteration",
  "documentation",
  "merge",
  "complete",
];

/**
 * Build the canonical run identity from the persistent tracking-issue number.
 * The decimal representation is zero-padded to at least four digits and never
 * truncated for larger issue numbers. SPEC-012, decision 1 / TAC-01.
 */
export function formatCanonicalRunId(repository: string, trackingIssueNumber: number): CanonicalRunId {
  const padded = String(trackingIssueNumber).padStart(4, "0");
  const runId = `RUN-${padded}`;
  const qualifiedRunId = `${repository}#${runId}`;
  // Normalize: upper-case, slashes and hyphens become hyphens, dots removed.
  const normalized = repository.toUpperCase().replace(/\//g, "-").replace(/\./g, "");
  const processInstance = `PI-${normalized}-${runId}`;
  return { runId, qualifiedRunId, processInstance };
}

export interface InitRunOptions {
  runId: string;
  repository: string;
  requirement: string;
  spec: string;
  issue?: number;
  branch?: string;
  maxAutomaticIterations?: number;
  /** Explicit path to the requirement document (relative to repo root). TAC-01. */
  requirementPath?: string;
  /** Explicit path to the spec document (relative to repo root). TAC-01. */
  specPath?: string;
  /** Delivery PR number if already known at init time. */
  deliveryPullRequest?: number;
  /** Delivery PR HEAD SHA if already known at init time. */
  deliveryHeadSha?: string;
}

export function initRunState(options: InitRunOptions): RunState {
  const timestamp = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: options.runId,
    repository: options.repository,
    requirement: options.requirement,
    spec: options.spec,
    issue: options.issue,
    branch: options.branch,
    requirementPath: options.requirementPath,
    specPath: options.specPath,
    deliveryPullRequest: options.deliveryPullRequest,
    deliveryHeadSha: options.deliveryHeadSha,
    phase: "requirement",
    createdAt: timestamp,
    updatedAt: timestamp,
    gates: [],
    iterations: [],
    maxAutomaticIterations: options.maxAutomaticIterations ?? 3,
    notes: [],
  };
}

/**
 * Idempotent init: if a state already exists for immutable fields, refuse to
 * silently change them. Returns the existing state unmodified when the
 * request matches; throws when it conflicts.
 */
export function reconcileInit(existing: RunState, options: InitRunOptions): RunState {
  const immutableMismatch: string[] = [];
  if (existing.repository !== options.repository) immutableMismatch.push("repository");
  if (existing.requirement !== options.requirement) immutableMismatch.push("requirement");
  if (existing.spec !== options.spec) immutableMismatch.push("spec");
  if (options.issue !== undefined && existing.issue !== undefined && existing.issue !== options.issue) {
    immutableMismatch.push("issue");
  }

  if (immutableMismatch.length > 0) {
    throw new Error(
      `init for run '${existing.runId}' conflicts with existing immutable fields: ${immutableMismatch.join(", ")}`,
    );
  }

  return existing;
}

export function upsertGate(
  state: RunState,
  gate: { id: string; type: GateType; question?: string; context?: GateDecisionContext },
): RunState {
  const timestamp = nowIso();
  const existingIndex = state.gates.findIndex((g) => g.id === gate.id);
  if (existingIndex >= 0) {
    return state;
  }
  const record: GateRecord = {
    id: gate.id,
    type: gate.type,
    result: "pending",
    createdAt: timestamp,
    updatedAt: timestamp,
    question: gate.question,
    context: gate.context,
  };
  return { ...state, gates: [...state.gates, record], updatedAt: timestamp };
}

export function resolveGate(
  state: RunState,
  gateId: string,
  update: Partial<Pick<GateRecord, "result" | "evidence" | "issue" | "decision" | "openedAt" | "context" | "publication" | "cleanupPending">>,
): RunState {
  const timestamp = nowIso();
  const index = state.gates.findIndex((g) => g.id === gateId);
  if (index < 0) {
    throw new Error(`unknown gate '${gateId}' on run '${state.runId}'`);
  }
  const gates = [...state.gates];
  gates[index] = { ...gates[index], ...update, updatedAt: timestamp };
  return { ...state, gates, updatedAt: timestamp };
}

export function findGate(state: RunState, gateId: string): GateRecord | undefined {
  return state.gates.find((g) => g.id === gateId);
}

export function findBlockingTechnicalGate(state: RunState): GateRecord | undefined {
  return state.gates.find(
    (gate) =>
      gate.type !== "human" &&
      (gate.result === "pending" || gate.result === "needs-human" || gate.result === "failed"),
  );
}

/**
 * A human gate is "open" (still blocking) only while it has not been
 * resolved yet, i.e. result is "pending" or "needs-human". Once a human has
 * decided -- approved ("passed") or rejected ("failed") -- the gate is
 * resolved and must not block forever. A rejected gate is surfaced
 * separately via computeNextAction so the caller can react instead of the
 * run silently advancing or getting stuck.
 */
export function hasOpenHumanGate(state: RunState): GateRecord | undefined {
  return state.gates.find((g) => g.type === "human" && (g.result === "pending" || g.result === "needs-human"));
}

/**
 * The most recently resolved human gate whose result was "failed" (rejected)
 * and that has not yet been acknowledged (see acknowledgeRejectedGate).
 */
export function findUnacknowledgedRejectedGate(state: RunState): GateRecord | undefined {
  return state.gates.find((g) => g.type === "human" && g.result === "failed" && !g.decision?.note?.startsWith("acknowledged:"));
}

export function findPendingGateCleanup(state: RunState): GateRecord | undefined {
  return state.gates.find((gate) => gate.type === "human" && gate.cleanupPending === true);
}

export function findPendingGatePublication(state: RunState): GateRecord | undefined {
  return state.gates.find(
    (gate) => gate.type === "human" && gate.publication !== undefined && gate.publication.status !== "open",
  );
}

export function needsGateReconciliation(state: RunState): boolean {
  return Boolean(
    findPendingGatePublication(state) ||
    findPendingGateCleanup(state) ||
    hasOpenHumanGate(state)?.issue,
  );
}

export function isMergeApprovalGate(gate: GateRecord): boolean {
  return (
    gate.type === "merge" ||
    gate.id === "merge-approval" ||
    gate.id.startsWith("merge-approval-") ||
    gate.id === "delivery-merge-approval" ||
    gate.id.startsWith("delivery-merge-approval-")
  );
}

export function findPassedMergeApprovalGate(state: RunState): GateRecord | undefined {
  return state.gates.find((gate) => gate.result === "passed" && isMergeApprovalGate(gate));
}

/**
 * A trusted reconciler must revisit an approved delivery merge until GitHub's
 * persisted merge effect has been recorded. This covers suppressed or failed
 * pull_request.closed workflows without weakening the SHA-bound gate.
 */
export function needsDeliveryMergeReconciliation(state: RunState): boolean {
  const deliveryPullRequest = state.deliveryPullRequest ?? state.pullRequest;
  const deliveryHeadSha = state.deliveryHeadSha ?? state.pullRequestHeadSha;
  return Boolean(
    deliveryPullRequest !== undefined &&
    deliveryHeadSha &&
    !state.deliveryMergeCommitSha &&
    findPassedMergeApprovalGate(state),
  );
}

function expectedDeliveryHeadSha(state: RunState): string | undefined {
  return (state.deliveryHeadSha ?? state.pullRequestHeadSha)?.toLowerCase();
}

export function hasPersistedDeliveryMergeEvidence(state: RunState): boolean {
  const deliveryPullRequest = state.deliveryPullRequest ?? state.pullRequest;
  return Boolean(
    deliveryPullRequest &&
      expectedDeliveryHeadSha(state) &&
      state.deliveryMergeCommitSha &&
      state.deliveryMergedAt &&
      findPassedMergeApprovalGate(state),
  );
}

export function classifyDeliveryPrMergeEffect(
  state: RunState,
  observedPullRequest?: number,
):
  | { kind: "record"; deliveryPullRequest: number }
  | { kind: "skip"; deliveryPullRequest: number; observedPullRequest: number }
  | { kind: "unbound" } {
  const deliveryPullRequest = state.deliveryPullRequest ?? state.pullRequest;
  if (!deliveryPullRequest) {
    return { kind: "unbound" };
  }
  if (observedPullRequest !== undefined && observedPullRequest !== deliveryPullRequest) {
    return { kind: "skip", deliveryPullRequest, observedPullRequest };
  }
  return { kind: "record", deliveryPullRequest };
}

export function recordDeliveryMergeEffect(
  state: RunState,
  effect: { pullRequest: number; approvedHeadSha: string; mergeCommitSha: string; mergedAt: string },
): RunState {
  if (!Number.isInteger(effect.pullRequest) || effect.pullRequest <= 0) {
    throw new Error("delivery pull request number must be a positive integer");
  }
  if (!/^[0-9a-f]{40}$/i.test(effect.approvedHeadSha)) {
    throw new Error("approved delivery head SHA must be a full 40-character Git SHA");
  }
  if (!/^[0-9a-f]{40}$/i.test(effect.mergeCommitSha)) {
    throw new Error("delivery merge commit SHA must be a full 40-character Git SHA");
  }

  const deliveryPullRequest = state.deliveryPullRequest ?? state.pullRequest;
  if (!deliveryPullRequest) {
    throw new Error(`no delivery PR is bound on run '${state.runId}'`);
  }
  if (deliveryPullRequest !== effect.pullRequest) {
    throw new Error(
      `run '${state.runId}' is bound to delivery PR #${deliveryPullRequest}; refusing merge effect for PR #${effect.pullRequest}`,
    );
  }

  const approvedHeadSha = effect.approvedHeadSha.toLowerCase();
  const expectedHead = expectedDeliveryHeadSha(state);
  if (!expectedHead) {
    throw new Error(`run '${state.runId}' has no bound delivery head SHA`);
  }
  if (expectedHead !== approvedHeadSha) {
    throw new Error(
      `delivery PR #${effect.pullRequest} merged from head ${approvedHeadSha}, expected approved head ${expectedHead}`,
    );
  }

  if (state.deliveryMergeCommitSha && state.deliveryMergeCommitSha.toLowerCase() !== effect.mergeCommitSha.toLowerCase()) {
    throw new Error(
      `run '${state.runId}' already records delivery merge commit ${state.deliveryMergeCommitSha}`,
    );
  }
  if (
    state.deliveryMergeCommitSha?.toLowerCase() === effect.mergeCommitSha.toLowerCase() &&
    state.deliveryMergedAt === effect.mergedAt
  ) {
    return state;
  }

  const mergeGate = findPassedMergeApprovalGate(state);
  if (!mergeGate) {
    throw new Error("cannot record delivery merge effect without a passed merge approval gate");
  }

  const mergeEvidence = [
    ...(mergeGate.evidence ?? []),
    `delivery-pr:${effect.pullRequest}`,
    `approved-head:${approvedHeadSha}`,
    `merge-commit:${effect.mergeCommitSha.toLowerCase()}`,
    `merged-at:${effect.mergedAt}`,
  ].filter((item, index, items) => items.indexOf(item) === index);
  const withEvidence = resolveGate(state, mergeGate.id, { evidence: mergeEvidence });
  return {
    ...withEvidence,
    deliveryMergeCommitSha: effect.mergeCommitSha.toLowerCase(),
    deliveryMergedAt: effect.mergedAt,
    updatedAt: nowIso(),
  };
}

export function acknowledgeRejectedGate(state: RunState, gateId: string, note: string): RunState {
  const gate = findGate(state, gateId);
  if (!gate || gate.result !== "failed") {
    throw new Error(`gate '${gateId}' is not a rejected human gate`);
  }
  return resolveGate(state, gateId, {
    decision: { ...(gate.decision ?? { approved: false, by: "unknown", at: nowIso() }), note: `acknowledged: ${note}` },
  });
}

/**
 * Upsert the documentation snapshot checkpoint.
 * Merges the provided partial update into the existing checkpoint (or creates
 * a new one) and stamps updatedAt. Pure; no I/O. SPEC-012, decision 2.
 */
export function upsertDocumentationSnapshot(
  state: RunState,
  update: Partial<import("./types.js").DocumentationSnapshotCheckpoint> &
    Pick<import("./types.js").DocumentationSnapshotCheckpoint, "schemaVersion" | "status" | "idempotencyKey" | "path" | "indexPath" | "obsidianBasePath" | "generatedAt" | "sourceHeadSha" | "auditIdempotencyKey">,
): RunState {
  const merged = { ...(state.documentationSnapshot ?? {}), ...update } as import("./types.js").DocumentationSnapshotCheckpoint;
  return { ...state, documentationSnapshot: merged, updatedAt: nowIso() };
}

export function transitionPhase(state: RunState, phase: PhaseId): RunState {
  if (phase === state.phase) return state;

  const currentIndex = PHASE_ORDER.indexOf(state.phase);
  const requestedIndex = PHASE_ORDER.indexOf(phase);
  if (requestedIndex !== currentIndex + 1) {
    throw new Error(
      `invalid phase transition '${state.phase}' -> '${phase}'; only the next phase '${PHASE_ORDER[currentIndex + 1] ?? "complete"}' is allowed`,
    );
  }

  const openHumanGate = hasOpenHumanGate(state);
  if (openHumanGate) {
    throw new Error(`cannot advance phase while human gate '${openHumanGate.id}' is open`);
  }
  const rejectedHumanGate = findUnacknowledgedRejectedGate(state);
  if (rejectedHumanGate) {
    throw new Error(`cannot advance phase while human gate '${rejectedHumanGate.id}' is rejected`);
  }
  const blockingTechnicalGate = findBlockingTechnicalGate(state);
  if (blockingTechnicalGate) {
    throw new Error(
      `cannot advance phase while technical gate '${blockingTechnicalGate.id}' is ${blockingTechnicalGate.result}`,
    );
  }
  if (iterationCapReached(state) && !iterationCapEscalationResolved(state) && phase !== "complete") {
    throw new Error("cannot advance phase after the automatic iteration cap was reached");
  }
  if (
    phase === "complete" &&
    !hasPersistedDeliveryMergeEvidence(state)
  ) {
    throw new Error("cannot complete a run without persisted delivery merge evidence");
  }

  // SPEC-012 TAC-05: completing a run also requires a persisted, audited
  // documentation snapshot. This mirrors the computeNextAction guard so that
  // callers that call transitionPhase directly are also protected.
  if (phase === "complete") {
    const snap = state.documentationSnapshot;
    if (!snap || snap.status !== "persisted" || !snap.commitSha || !snap.auditConfirmedAt) {
      throw new Error("cannot complete a run without a persisted and audited documentation snapshot");
    }
  }

  return { ...state, phase, updatedAt: nowIso() };
}

export function bindPullRequest(
  state: RunState,
  pullRequest: number,
  headSha: string,
): RunState {
  if (!Number.isInteger(pullRequest) || pullRequest <= 0) {
    throw new Error("pull request number must be a positive integer");
  }
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    throw new Error("pull request head SHA must be a full 40-character Git SHA");
  }
  const normalizedHeadSha = headSha.toLowerCase();
  if (state.pullRequest !== undefined && state.pullRequest !== pullRequest) {
    throw new Error(
      `run '${state.runId}' is already bound to PR #${state.pullRequest}; refusing PR #${pullRequest}`,
    );
  }
  if (state.pullRequest === pullRequest && state.pullRequestHeadSha === normalizedHeadSha) {
    return state;
  }
  const headChanged =
    state.pullRequest === pullRequest &&
    state.pullRequestHeadSha !== undefined &&
    state.pullRequestHeadSha !== normalizedHeadSha;
  const gates = headChanged
    ? state.gates.flatMap((gate) => {
        // A human merge approval is named for one exact SHA. Retaining it as
        // an open gate would allow the old issue timeline to decide the new
        // head, so remove it and require a fresh SHA-specific gate.
        if (gate.type === "human" && isMergeApprovalGate(gate)) return [];
        if (gate.type === "review" || gate.type === "merge") {
          return [{
            ...gate,
            result: "pending" as const,
            evidence: undefined,
            decision: undefined,
            updatedAt: nowIso(),
          }];
        }
        return [gate];
      })
    : state.gates;
  return {
    ...state,
    pullRequest,
    pullRequestHeadSha: normalizedHeadSha,
    gates,
    updatedAt: nowIso(),
  };
}

/**
 * Bind the delivery PR (against the default branch) and its HEAD SHA.
 * Once the PR number is set it is immutable; the HEAD SHA can be updated
 * to a new checkpoint, which invalidates any SHA-specific merge approval and
 * clears persisted merge evidence gathered for the old delivery head.
 * TAC-01, TAC-03.
 */
export function bindDeliveryPullRequest(
  state: RunState,
  pullRequest: number,
  headSha: string,
): RunState {
  if (!Number.isInteger(pullRequest) || pullRequest <= 0) {
    throw new Error("pull request number must be a positive integer");
  }
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    throw new Error("delivery pull request head SHA must be a full 40-character Git SHA");
  }
  const normalizedHeadSha = headSha.toLowerCase();
  if (state.deliveryPullRequest !== undefined && state.deliveryPullRequest !== pullRequest) {
    throw new Error(
      `run '${state.runId}' is already bound to delivery PR #${state.deliveryPullRequest}; refusing PR #${pullRequest}`,
    );
  }
  if (state.deliveryPullRequest === pullRequest && state.deliveryHeadSha === normalizedHeadSha) {
    return state; // idempotent
  }
  const headChanged =
    state.deliveryPullRequest === pullRequest &&
    state.deliveryHeadSha !== undefined &&
    state.deliveryHeadSha !== normalizedHeadSha;
  // Invalidate SHA-specific merge approvals when the delivery head changes.
  // They authorize one exact head, so keeping them (even as open gates) would
  // let the old issue timeline or gate result speak for the new SHA.
  const gates = headChanged
    ? state.gates.flatMap((gate) => (isMergeApprovalGate(gate) ? [] : [gate]))
    : state.gates;
  return {
    ...state,
    deliveryPullRequest: pullRequest,
    deliveryHeadSha: normalizedHeadSha,
    deliveryMergeCommitSha: headChanged ? undefined : state.deliveryMergeCommitSha,
    deliveryMergedAt: headChanged ? undefined : state.deliveryMergedAt,
    gates,
    updatedAt: nowIso(),
  };
}

/**
 * Bind the implementation PR (Coding Agent, against the delivery branch) and
 * its HEAD SHA. Once the PR number is set it is immutable; the SHA can be
 * updated, which invalidates `review` and `runtime` gates.
 * TAC-01, TAC-10.
 */
export function bindImplementationPullRequest(
  state: RunState,
  pullRequest: number,
  headSha: string,
): RunState {
  if (!Number.isInteger(pullRequest) || pullRequest <= 0) {
    throw new Error("pull request number must be a positive integer");
  }
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    throw new Error("implementation pull request head SHA must be a full 40-character Git SHA");
  }
  const normalizedHeadSha = headSha.toLowerCase();
  if (state.implementationPullRequest !== undefined && state.implementationPullRequest !== pullRequest) {
    throw new Error(
      `run '${state.runId}' is already bound to implementation PR #${state.implementationPullRequest}; refusing PR #${pullRequest}`,
    );
  }
  if (state.implementationPullRequest === pullRequest && state.implementationHeadSha === normalizedHeadSha) {
    return state; // idempotent
  }
  const headChanged =
    state.implementationPullRequest === pullRequest &&
    state.implementationHeadSha !== undefined &&
    state.implementationHeadSha !== normalizedHeadSha;
  // Invalidate review and runtime gates when the implementation head changes.
  const gates = headChanged
    ? state.gates.map((gate) =>
        gate.type === "review" || gate.type === "runtime"
          ? { ...gate, result: "pending" as const, evidence: undefined, updatedAt: nowIso() }
          : gate,
      )
    : state.gates;
  return {
    ...state,
    implementationPullRequest: pullRequest,
    implementationHeadSha: normalizedHeadSha,
    gates,
    updatedAt: nowIso(),
  };
}

export function startIteration(state: RunState): { state: RunState; iteration: IterationRecord } {
  const index = state.iterations.length + 1;
  const iteration: IterationRecord = { index, startedAt: nowIso() };
  return { state: { ...state, iterations: [...state.iterations, iteration], updatedAt: nowIso() }, iteration };
}

export function finishIteration(
  state: RunState,
  index: number,
  result: "passed" | "failed",
  findings?: string[],
): RunState {
  const iterations = state.iterations.map((it) =>
    it.index === index ? { ...it, finishedAt: nowIso(), result, findings } : it,
  );
  return { ...state, iterations, updatedAt: nowIso() };
}

/**
 * True once the number of failed iterations reaches the cap -- the run must
 * stop and open a human gate instead of attempting another automatic fix.
 */
export function iterationCapReached(state: RunState): boolean {
  const failed = state.iterations.filter((it) => it.result === "failed").length;
  return failed >= state.maxAutomaticIterations;
}

export function iterationCapEscalationResolved(state: RunState): boolean {
  return state.gates.some(
    (gate) =>
      gate.id === "needs-human-escalation" &&
      gate.type === "human" &&
      (gate.result === "passed" ||
        (gate.result === "failed" && gate.decision?.note?.startsWith("acknowledged:"))),
  );
}

export interface NextAction {
  action:
    | "await-human-gate"
    | "await-technical-gate"
    | "technical-gate-failed"
    | "human-gate-rejected"
    | "advance-phase"
    | "escalate-iteration-cap"
    | "run-complete"
    | "resolve-gate"
    | "cleanup-human-gate"
    | "publish-human-gate"
    | "persist-run-documentation";
  detail: string;
  gate?: GateRecord;
}

/**
 * Pure decision function: given the current state, what should happen next?
 * Never mutates state, never talks to GitHub. Callers (CLI, skill, future
 * supervisor) act on this.
 */
export function computeNextAction(state: RunState): NextAction {
  const pendingPublication = findPendingGatePublication(state);
  if (pendingPublication) {
    return {
      action: "publish-human-gate",
      detail: `Human gate '${pendingPublication.id}' has a durable ${pendingPublication.publication?.status} publication checkpoint; resume publication.`,
      gate: pendingPublication,
    };
  }

  const pendingCleanup = findPendingGateCleanup(state);
  if (pendingCleanup) {
    return {
      action: "cleanup-human-gate",
      detail: `Human gate '${pendingCleanup.id}' is decided; retry idempotent comment and label cleanup.`,
      gate: pendingCleanup,
    };
  }

  const openHumanGate = hasOpenHumanGate(state);
  if (openHumanGate) {
    return {
      action: "await-human-gate",
      detail: `Human gate '${openHumanGate.id}' is open (result: ${openHumanGate.result}). ${
        openHumanGate.issue ? `See ${openHumanGate.issue.url}` : "No gate issue opened yet."
      }`,
      gate: openHumanGate,
    };
  }

  const rejectedGate = findUnacknowledgedRejectedGate(state);
  if (rejectedGate) {
    return {
      action: "human-gate-rejected",
      detail: `Human gate '${rejectedGate.id}' was rejected. ${
        rejectedGate.issue ? `See ${rejectedGate.issue.url}` : ""
      } Decide how to proceed, then call acknowledgeRejectedGate.`,
      gate: rejectedGate,
    };
  }

  const blockingTechnicalGate = findBlockingTechnicalGate(state);
  if (blockingTechnicalGate) {
    if (blockingTechnicalGate.result === "failed") {
      return {
        action: "technical-gate-failed",
        detail: `Technical gate '${blockingTechnicalGate.id}' failed; fix the finding and resolve the same gate with new evidence before advancing.`,
        gate: blockingTechnicalGate,
      };
    }
    return {
      action: "await-technical-gate",
      detail: `Technical gate '${blockingTechnicalGate.id}' is ${blockingTechnicalGate.result}; evidence is required before advancing.`,
      gate: blockingTechnicalGate,
    };
  }

  if (
    iterationCapReached(state) &&
    !iterationCapEscalationResolved(state) &&
    state.phase !== "complete"
  ) {
    return {
      action: "escalate-iteration-cap",
      detail: `${state.maxAutomaticIterations} automatic iterations failed; escalate to a human gate before continuing.`,
    };
  }

  if (state.phase === "merge" && !hasPersistedDeliveryMergeEvidence(state)) {
    const mergeGate = findPassedMergeApprovalGate(state);
    return {
      action: "await-technical-gate",
      detail: mergeGate
        ? `Delivery PR merge effect for gate '${mergeGate.id}' is not yet persisted; wait for the bound PR merge to be verified before completing the run.`
        : "Delivery PR merge approval and persisted merge effect are both required before completing the run.",
      gate: mergeGate,
    };
  }

  // SPEC-012 TAC-04/TAC-05: Once merge evidence is confirmed, require a
  // persisted and audited documentation snapshot before completing the run.
  if (state.phase === "merge" && hasPersistedDeliveryMergeEvidence(state)) {
    const snap = state.documentationSnapshot;
    if (!snap || snap.status !== "persisted" || !snap.commitSha || !snap.auditConfirmedAt) {
      return {
        action: "persist-run-documentation",
        detail: snap
          ? `Documentation snapshot is in status '${snap.status}' (commitSha: ${snap.commitSha ?? "missing"}, auditConfirmedAt: ${snap.auditConfirmedAt ?? "missing"}); resume or complete the documentation write and audit.`
          : "Delivery merge is confirmed; a documentation snapshot must be persisted and audited before the run can complete.",
      };
    }
  }

  if (state.phase === "complete") {
    return { action: "run-complete", detail: `Run '${state.runId}' is complete.` };
  }

  const currentIndex = PHASE_ORDER.indexOf(state.phase);
  const nextPhase = PHASE_ORDER[currentIndex + 1] ?? "complete";
  return {
    action: "advance-phase",
    detail: `Phase '${state.phase}' has no open gates; proceed to '${nextPhase}'.`,
  };
}

export function gateResultOf(state: RunState, gateId: string): GateResult | undefined {
  return findGate(state, gateId)?.result;
}

// ---------------------------------------------------------------------------
// SPEC-009: Review-remediation state helpers (pure functions)
// ---------------------------------------------------------------------------

/**
 * Build the canonical idempotency key for one review thread.
 * Key = repository + pullRequest + reviewId + threadId + reviewedHeadSha.
 * SPEC-009, decision 3.
 */
export function buildReviewIdempotencyKey(
  repository: string,
  pullRequest: number,
  reviewId: number,
  threadId: string,
  reviewedHeadSha: string,
): string {
  return `${repository.toLowerCase()}:pr${pullRequest}:review${reviewId}:thread${threadId}:sha${reviewedHeadSha.toLowerCase()}`;
}

/**
 * Classify one review thread into a ReviewThreadStatus.
 * Pure function — no I/O, no GitHub calls.
 * SPEC-009, decisions 2 & 8.
 */
export function classifyReviewThread(opts: {
  body: string;
  isResolved: boolean;
  isOutdated: boolean;
  authorLogin: string;
  selfActorLogin: string;
  trustedActors: string[];
}): ReviewThreadStatus {
  if (opts.isResolved) return "resolved";
  if (opts.isOutdated) return "outdated";
  // Bot-own replies must never start an implementation loop.
  if (opts.authorLogin.toLowerCase() === opts.selfActorLogin.toLowerCase()) return "informational";
  // Unknown or untrusted reviewer — treat as informational to avoid scope creep.
  const isTrusted = opts.trustedActors.some((a) => a.toLowerCase() === opts.authorLogin.toLowerCase());
  if (!isTrusted) return "informational";
  // Detect conflict-/gate-triggering keywords (SPEC-009, decision 4).
  const conflictPattern =
    /\b(conflict|widerspruch|scope(?:[-_ ]+)erweiterung|auth(?:orization)?|permission|secret|cost|destruktiv)\b/i;
  if (conflictPattern.test(opts.body)) return "conflicting";
  return "actionable";
}

/**
 * True when the run already has an active review-fix iteration in progress
 * (at least one thread is in 'implementing'). A second event for the same
 * SHA must not start another iteration. SPEC-009, decision 6.
 */
export function isReviewIterationActive(state: RunState): boolean {
  return (state.reviewThreads ?? []).some((t) => t.status === "implementing");
}

/**
 * True when the run has already processed a review for the given idempotency
 * key. Duplicate event delivery for the same key is a no-op. SPEC-009, TAC-09.
 */
export function isReviewThreadAlreadyProcessed(state: RunState, idempotencyKey: string): boolean {
  return (state.reviewThreads ?? []).some((t) => t.idempotencyKey === idempotencyKey);
}

/**
 * Record a new review submission on the run.
 * Idempotent: if the same reviewId is already recorded, returns state unchanged.
 * SPEC-009, decision 3 & TAC-09.
 */
export function recordReview(state: RunState, review: ReviewRecord): RunState {
  const existing = (state.reviews ?? []).find((r) => r.reviewId === review.reviewId);
  if (existing) return state; // idempotent
  return {
    ...state,
    reviews: [...(state.reviews ?? []), review],
    updatedAt: nowIso(),
  };
}

/**
 * Insert a review thread record. If a thread with the same idempotencyKey
 * already exists, the call is a no-op (returns state unchanged).
 * SPEC-009, TAC-09.
 */
export function upsertReviewThread(state: RunState, thread: ReviewThreadRecord): RunState {
  const alreadyPresent = (state.reviewThreads ?? []).some((t) => t.idempotencyKey === thread.idempotencyKey);
  if (alreadyPresent) return state;
  return {
    ...state,
    reviewThreads: [...(state.reviewThreads ?? []), thread],
    updatedAt: nowIso(),
  };
}

/**
 * Update an existing review thread record by idempotency key.
 * Throws if the thread is not found.
 */
export function updateReviewThread(
  state: RunState,
  idempotencyKey: string,
  update: Partial<Omit<ReviewThreadRecord, "idempotencyKey">>,
): RunState {
  const threads = state.reviewThreads ?? [];
  const index = threads.findIndex((t) => t.idempotencyKey === idempotencyKey);
  if (index < 0) throw new Error(`review thread '${idempotencyKey}' not found on run '${state.runId}'`);
  const updated = [...threads];
  updated[index] = { ...updated[index], ...update };
  return { ...state, reviewThreads: updated, updatedAt: nowIso() };
}

/**
 * Invalidate review and CI evidence when the implementation HEAD SHA changes.
 * All thread records for the old SHA are marked 'outdated'; thread records
 * for the new SHA are preserved. SPEC-009, TAC-08.
 */
export function invalidateReviewEvidenceForSha(state: RunState, oldSha: string): RunState {
  if (!state.reviewThreads) return state;
  const normalizedOld = oldSha.toLowerCase();
  const updatedThreads = state.reviewThreads.map((t) =>
    t.reviewedHeadSha.toLowerCase() === normalizedOld && t.status !== "resolved"
      ? { ...t, status: "outdated" as ReviewThreadStatus }
      : t,
  );
  return { ...state, reviewThreads: updatedThreads, updatedAt: nowIso() };
}

/**
 * Increment the review-loop failure counter. Opens a human gate escalation
 * when the counter reaches the cap. Returns the updated state.
 * SPEC-009, decision 6.
 */
export function incrementReviewLoopCounter(state: RunState): RunState {
  return { ...state, reviewLoopCounter: (state.reviewLoopCounter ?? 0) + 1, updatedAt: nowIso() };
}

/**
 * True when the review-loop failure counter has reached the run's automatic
 * iteration cap. SPEC-009, decision 6.
 */
export function reviewLoopCapReached(state: RunState): boolean {
  return (state.reviewLoopCounter ?? 0) >= state.maxAutomaticIterations;
}

/**
 * Detect whether the harness source repository and target repository are
 * identical (self-hosting). When true, the bootstrap must use an already
 * published immutable ref — never the unmerged branch.
 * SPEC-009, TAC-02.
 */
export function detectSelfHosting(
  harnessSourceRepository: string,
  targetRepository: string,
): boolean {
  return harnessSourceRepository.toLowerCase() === targetRepository.toLowerCase();
}
