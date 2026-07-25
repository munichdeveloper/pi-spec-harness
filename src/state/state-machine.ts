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

/**
 * A human gate blocks all forward progress until it has result "passed" with
 * a recorded decision.approved === true. This is intentionally the single
 * choke point for "does a human need to look at this?".
 */
export function hasOpenHumanGate(state: RunState): GateRecord | undefined {
  return state.gates.find((g) => g.type === "human" && g.result !== "passed");
}

export function transitionPhase(state: RunState, phase: PhaseId): RunState {
  return { ...state, phase, updatedAt: nowIso() };
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
