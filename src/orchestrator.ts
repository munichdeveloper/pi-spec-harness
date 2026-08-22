/**
 * Bounded, idempotent phase-advance orchestrator.
 *
 * TAC-04: The orchestrator runs only known phase handlers, stops at the first
 * piece of real work, error, or open gate, and records every step it took.
 * It never performs more than `maxSteps` state-machine transitions in a single
 * invocation so that the call is always bounded and auditable.
 */

import { github } from "./github/gh.js";
import { PHASE_ORDER, computeNextAction, transitionPhase } from "./state/state-machine.js";
import type { NextAction } from "./state/state-machine.js";
import type { StateStore } from "./state/state-store.js";

export interface OrchestratorStep {
  stepNumber: number;
  action: string;
  detail: string;
}

export type OrchestratorStopReason =
  | "open-gate"
  | "complete"
  | "max-steps"
  | "error"
  | "target-phase";

export interface OrchestratorResult {
  steps: OrchestratorStep[];
  stopReason: OrchestratorStopReason;
  stopDetail: string;
  finalNextAction: NextAction;
}

const DEFAULT_MAX_STEPS = 10;

/**
 * Run the orchestrator against the given store.
 *
 * Each iteration:
 * 1. Loads the current state from the store.
 * 2. Calls `computeNextAction`.
 * 3. If the action is `advance-phase`, transitions and persists, then loops.
 * 4. For any other action (gate, complete, error) stops and reports.
 *
 * Side effect: closes the tracking issue when the run reaches `complete`.
 */
export async function orchestrate(
  store: StateStore,
  maxSteps = DEFAULT_MAX_STEPS,
  stopAtPhase?: import("./state/types.js").PhaseId,
): Promise<OrchestratorResult> {
  const steps: OrchestratorStep[] = [];

  for (let i = 1; i <= maxSteps; i++) {
    const state = await store.load();
    const next = computeNextAction(state);

    if (stopAtPhase && state.phase === stopAtPhase) {
      return { steps, stopReason: "target-phase", stopDetail: `Reached requested target phase '${stopAtPhase}'.`, finalNextAction: next };
    }

    if (next.action === "run-complete") {
      steps.push({ stepNumber: i, action: next.action, detail: next.detail });
      // Close the tracking issue on completion
      if (store.issueRef) {
        await github.closeIssue(
          store.issueRef.repository,
          store.issueRef.number,
          `Harness: Run \`${state.runId}\` ist abgeschlossen (Phase \`complete\`).`,
        );
      }
      return {
        steps,
        stopReason: "complete",
        stopDetail: next.detail,
        finalNextAction: next,
      };
    }

    if (next.action !== "advance-phase") {
      // Stopped at a gate, error, or escalation -- report and exit
      return {
        steps,
        stopReason: "open-gate",
        stopDetail: next.detail,
        finalNextAction: next,
      };
    }

    // Safe to advance: transition and persist
    const currentPhase = state.phase;
    const currentIndex = PHASE_ORDER.indexOf(currentPhase);
    const nextPhase = PHASE_ORDER[currentIndex + 1];
    if (!nextPhase) {
      return {
        steps,
        stopReason: "complete",
        stopDetail: `Phase '${currentPhase}' has no successor.`,
        finalNextAction: next,
      };
    }

    const advanced = transitionPhase(state, nextPhase);
    await store.save(advanced);
    steps.push({
      stepNumber: i,
      action: "advance-phase",
      detail: `Advanced from '${currentPhase}' to '${nextPhase}'.`,
    });
  }

  // Reached the step limit without stopping naturally
  const finalState = await store.load();
  const finalNext = computeNextAction(finalState);
  return {
    steps,
    stopReason: "max-steps",
    stopDetail: `Reached the orchestration step limit of ${maxSteps}.`,
    finalNextAction: finalNext,
  };
}
