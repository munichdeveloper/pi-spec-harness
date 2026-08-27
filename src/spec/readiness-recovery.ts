import { github } from "../github/gh.js";
import type { StateStore } from "../state/state-store.js";
import type { ExecutorPolicy, ReadinessDecision } from "./readiness.js";
import { findReadinessDispatch, type ReadinessDispatchPolicy } from "./readiness-dispatch.js";

/** Recover transport, not uncertain agent side effects. The same workflow run
 * and canonical work receipt survive retries; completed output can be republished.
 */
export async function recoverReadinessTransport(input: {
  store: StateStore;
  workflow: (executor: string) => ReadinessDispatchPolicy;
  currentExecutors: () => Promise<ExecutorPolicy[]>;
  costCeiling: number;
  audit: (identity: string, description: string) => Promise<void>;
  now?: () => number;
}): Promise<ReadinessDecision | { action: "observe-work"; reason: string } | undefined> {
  const state = await input.store.load();
  const now = input.now ?? Date.now;
  for (const work of state.readiness?.work ?? []) {
    if (!work.receipt || work.result) continue;
    const policy = input.workflow(work.executorId);
    await findReadinessDispatch(work, policy); // Independently validate canonical receipt provenance.
    const runId = Number(work.receipt.slice("github-actions:".length));
    const run = await github.viewReadinessWorkflowRun(policy.repository, runId) as { status?: string; conclusion?: string; run_attempt?: number };
    if (run.status !== "completed" || run.conclusion === "success") continue;
    const decide = async (action: "human-decision" | "await-executor", reason: string) => {
      const decision: ReadinessDecision = { action, reason, executorId: work.executorId };
      state.readiness!.decision = decision;
      await input.store.save(state);
      await input.audit(`${work.key}:recovery:${reason}`, `Work ${work.key}: ${reason}; next responsibility ${action}.`);
      return decision;
    };
    if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt! < 1) return decide("human-decision", "invalid-transport-attempt");
    if (work.execution && work.execution.status !== "completed") return decide("human-decision", "agent-execution-outcome-requires-reconciliation");
    if (!["failure", "cancelled", "timed_out", "startup_failure"].includes(run.conclusion ?? "")) {
      return decide("human-decision", "unsupported-terminal-transport-state");
    }
    if (!work.execution) {
      const matches = (await input.currentExecutors()).filter(p => p.id === work.executorId);
      const p = matches[0];
      if (matches.length !== 1 || !p.authorized || !p.available || !p.capabilities.includes(work.kind)
        || !Number.isFinite(p.maxTaskCost) || p.maxTaskCost < 0 || !Number.isFinite(input.costCeiling)
        || p.maxTaskCost > input.costCeiling) return decide("await-executor", "executor-unavailable-for-transport-retry");
    }
    const prior = work.transportRecovery;
    if (prior && now() - Date.parse(prior.occurredAt) < 60000) {
      return { action: "observe-work", reason: "transport-retry-backoff" };
    }
    if (prior && (!Number.isSafeInteger(prior.submissions) || prior.submissions >= 3 || !Number.isFinite(Date.parse(prior.occurredAt)))) {
      return decide("human-decision", "transport-retry-budget-exhausted-or-invalid");
    }
    work.transportRecovery = { submissions: (prior?.submissions ?? 0) + 1, sourceAttempt: run.run_attempt!, occurredAt: new Date(now()).toISOString() };
    await input.store.save(state); // Includes ambiguous API requests in the bound.
    await input.audit(`${work.key}:retry:${work.transportRecovery.submissions}:prepared`, `Prepare transport retry ${work.transportRecovery.submissions} for ${work.receipt}; no new work identity.`);
    await github.rerunReadinessWorkflow(policy.repository, runId);
    await input.audit(`${work.key}:retry:${work.transportRecovery.submissions}:submitted`, `Submitted transport retry for ${work.receipt}; next actor: existing executor workflow.`);
    return { action: "observe-work", reason: "transport-retry-submitted" };
  }
  return undefined;
}
