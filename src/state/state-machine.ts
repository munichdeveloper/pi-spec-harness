import { nowIso } from "./store.js";
import type { GateRecord, GateResult, GateType, IterationRecord, PhaseId, RunState } from "./types.js";
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

export interface InitRunOptions {
  runId: string;
  repository: string;
  requirement: string;
  spec: string;
  issue?: number;
  branch?: string;
  maxAutomaticIterations?: number;
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
  gate: { id: string; type: GateType; question?: string },
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
  };
  return { ...state, gates: [...state.gates, record], updatedAt: timestamp };
}

export function resolveGate(
  state: RunState,
  gateId: string,
  update: Partial<Pick<GateRecord, "result" | "evidence" | "issue" | "decision">>,
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

export function acknowledgeRejectedGate(state: RunState, gateId: string, note: string): RunState {
  const gate = findGate(state, gateId);
  if (!gate || gate.result !== "failed") {
    throw new Error(`gate '${gateId}' is not a rejected human gate`);
  }
  return resolveGate(state, gateId, {
    decision: { ...(gate.decision ?? { approved: false, by: "unknown", at: nowIso() }), note: `acknowledged: ${note}` },
  });
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
  if (iterationCapReached(state) && phase !== "complete") {
    throw new Error("cannot advance phase after the automatic iteration cap was reached");
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
  if (state.pullRequest !== undefined && state.pullRequest !== pullRequest) {
    throw new Error(
      `run '${state.runId}' is already bound to PR #${state.pullRequest}; refusing PR #${pullRequest}`,
    );
  }
  if (state.pullRequest === pullRequest && state.pullRequestHeadSha === headSha) {
    return state;
  }
  const headChanged =
    state.pullRequest === pullRequest &&
    state.pullRequestHeadSha !== undefined &&
    state.pullRequestHeadSha !== headSha;
  const gates = headChanged
    ? state.gates.map((gate) =>
        gate.type === "review"
          ? {
              ...gate,
              result: "pending" as const,
              evidence: undefined,
              updatedAt: nowIso(),
            }
          : gate,
      )
    : state.gates;
  return {
    ...state,
    pullRequest,
    pullRequestHeadSha: headSha.toLowerCase(),
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

export interface NextAction {
  action:
    | "await-human-gate"
    | "await-technical-gate"
    | "technical-gate-failed"
    | "human-gate-rejected"
    | "advance-phase"
    | "escalate-iteration-cap"
    | "run-complete"
    | "resolve-gate";
  detail: string;
  gate?: GateRecord;
}

/**
 * Pure decision function: given the current state, what should happen next?
 * Never mutates state, never talks to GitHub. Callers (CLI, skill, future
 * supervisor) act on this.
 */
export function computeNextAction(state: RunState): NextAction {
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

  if (iterationCapReached(state) && state.phase !== "complete") {
    return {
      action: "escalate-iteration-cap",
      detail: `${state.maxAutomaticIterations} automatic iterations failed; escalate to a human gate before continuing.`,
    };
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
