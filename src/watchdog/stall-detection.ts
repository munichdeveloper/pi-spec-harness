import { computeNextAction, needsDeliveryMergeReconciliation, needsGateReconciliation } from "../state/state-machine.js";
import type { RunState } from "../state/types.js";

export interface StallWatchdogOptions {
  staleAfterMinutes: number;
  maxNudges: number;
}

export interface StalledRunFinding {
  runId: string;
  actionKey: "agent-assign";
  disposition: "nudge" | "escalate";
  staleMinutes: number;
  nudgeCount: number;
}

/** Pure, side-effect-free eligibility decision for SPEC-011. */
export function detectStalledRuns(
  states: RunState[],
  now: string,
  options: StallWatchdogOptions,
): StalledRunFinding[] {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error(`invalid ISO timestamp: ${now}`);
  if (!Number.isFinite(options.staleAfterMinutes) || options.staleAfterMinutes <= 0) {
    throw new Error("staleAfterMinutes must be greater than zero");
  }
  if (!Number.isInteger(options.maxNudges) || options.maxNudges < 1) {
    throw new Error("maxNudges must be a positive integer");
  }

  return states.flatMap((state): StalledRunFinding[] => {
    if (state.phase !== "implementation" || state.agentAssignment) return [];
    if (state.gates.some((gate) => gate.type === "human" && (gate.result === "pending" || gate.result === "needs-human"))) return [];
    if (needsGateReconciliation(state) || needsDeliveryMergeReconciliation(state)) return [];
    if (computeNextAction(state).action === "persist-run-documentation") return [];

    const nudges = (state.watchdog?.nudges ?? []).filter((nudge) => nudge.actionKey === "agent-assign");
    const latestNudge = nudges.at(-1)?.dispatchedAt;
    const referenceMs = Math.max(Date.parse(state.updatedAt), latestNudge ? Date.parse(latestNudge) : 0);
    const staleMinutes = Math.floor((nowMs - referenceMs) / 60_000);
    if (!Number.isFinite(referenceMs) || staleMinutes < options.staleAfterMinutes) return [];

    return [{
      runId: state.runId,
      actionKey: "agent-assign",
      disposition: nudges.length >= options.maxNudges ? "escalate" : "nudge",
      staleMinutes,
      nudgeCount: nudges.length,
    }];
  });
}
