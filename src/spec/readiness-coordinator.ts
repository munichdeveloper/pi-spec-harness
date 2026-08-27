import { createHash } from "node:crypto";
import { assertHygiene } from "../state/hygiene.js";
import type { StateStore } from "../state/state-store.js";
import { evaluateReadiness, type ExecutorPolicy, type ReadinessDecision, type VerifiedSpikeEvidence } from "./readiness.js";

export interface ReadinessWork {
  key: string;
  revision: string;
  kind: "spike" | "implementation";
  executorId: string;
  blockerId?: string;
  attempt: number;
  issue?: number;
  receipt?: string;
  auditConfirmed?: boolean;
  result?: VerifiedSpikeEvidence;
}
export interface ReadinessCheckpoint {
  schemaVersion: 1;
  revision: string;
  implementationKey: string;
  work: ReadinessWork[];
  decision?: ReadinessDecision;
}
/** All ports are trusted infrastructure, never instructions taken from issue text.
 * Calls must run under the repository/spec concurrency lock. Creation/dispatch
 * ports must deduplicate against the authoritative API using the supplied key.
 */
export interface ReadinessPorts {
  ensureImplementationIssue(key: string): Promise<number>;
  ensureSpikeIssue(work: ReadinessWork): Promise<number>;
  reconcileReadinessLabels(issue: number, decision: ReadinessDecision): Promise<void>;
  currentExecutors(): Promise<ExecutorPolicy[]>;
  findReadinessWork(key: string): Promise<string | undefined>;
  dispatchReadinessWork(work: ReadinessWork): Promise<string>;
  confirmReadinessAudit(work: ReadinessWork): Promise<void>;
  confirmSpikeResultAudit(work: ReadinessWork, result: VerifiedSpikeEvidence): Promise<void>;
  /** Must validate producer identity, receipt and revision before returning. */
  readVerifiedSpikeResult(work: ReadinessWork): Promise<VerifiedSpikeEvidence | undefined>;
}
export type ReconcileReadinessResult = ReadinessDecision | { action: "observe-work"; reason: string; workKey: string };

function key(parts: unknown[]): string {
  return `readiness-${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

export async function reconcileReadiness(
  store: StateStore,
  context: { specId: string; approved: boolean; revision: string; contract: unknown; costCeiling: number },
  ports: ReadinessPorts,
): Promise<ReconcileReadinessResult> {
  const state = await store.load();
  if (state.spec !== context.specId) throw new Error("Readiness spec does not match canonical run");
  if (!context.approved) return { action: "await-approval", reason: "spec-not-approved" };
  const save = async () => { assertHygiene(state); await store.save(state); };
  if (!state.readiness) {
    state.readiness = {
      schemaVersion: 1, revision: context.revision, work: [],
      implementationKey: key([state.repository, state.runId, state.spec, "implementation-issue"]),
    };
    await save();
  }
  const checkpoint = state.readiness;
  if (checkpoint.revision !== context.revision) {
    // Do not launch competing work against a new revision while old work exists.
    const decision = { action: "human-decision" as const, reason: "spec-revision-changed-requires-reconciliation" };
    checkpoint.decision = decision;
    await save();
    if (state.issue) await ports.reconcileReadinessLabels(state.issue, decision);
    return decision;
  }
  if (!state.issue) {
    state.issue = await ports.ensureImplementationIssue(checkpoint.implementationKey);
    if (!Number.isSafeInteger(state.issue) || state.issue <= 0) throw new Error("Invalid implementation issue receipt");
    await save();
  }
  const resume = async (work: ReadinessWork): Promise<boolean> => {
    if (!work.issue) {
      work.issue = work.kind === "implementation" ? state.issue : await ports.ensureSpikeIssue(work);
      if (!Number.isSafeInteger(work.issue) || work.issue! <= 0) throw new Error("Invalid work issue receipt");
      await save();
    }
    if (!work.receipt) {
      // Recover an accepted dispatch before considering a new submission.
      const receipt = await ports.findReadinessWork(work.key);
      if (receipt) work.receipt = receipt;
      else {
        const policy = await ports.currentExecutors();
        const selected = policy.filter(e => e.id === work.executorId);
        if (selected.length !== 1 || selected[0].authorized !== true || selected[0].available !== true
          || !selected[0].capabilities.includes(work.kind)
          || !Number.isFinite(context.costCeiling) || context.costCeiling < 0
          || !Number.isFinite(selected[0].maxTaskCost) || selected[0].maxTaskCost < 0
          || selected[0].maxTaskCost > context.costCeiling) return false;
        work.receipt = await ports.dispatchReadinessWork(work);
      }
      if (!work.receipt?.trim()) throw new Error("Missing dispatch receipt");
      await save();
    }
    if (!work.auditConfirmed) {
      await ports.confirmReadinessAudit(work);
      work.auditConfirmed = true;
      await save();
    }
    return true;
  };

  for (const work of checkpoint.work.filter(w => !w.result)) {
    if (!await resume(work)) {
      const decision = { action: "await-executor" as const, reason: "prepared-executor-unavailable", blockerId: work.blockerId };
      checkpoint.decision = decision;
      await save();
      await ports.reconcileReadinessLabels(state.issue, decision);
      return decision;
    }
    if (work.kind === "implementation") return { action: "observe-work", reason: "implementation-already-dispatched", workKey: work.key };
    const result = await ports.readVerifiedSpikeResult(work);
    if (!result) return { action: "observe-work", reason: "spike-result-pending", workKey: work.key };
    if (result.specRevision !== work.revision || result.blockerId !== work.blockerId) throw new Error("Spike evidence binding mismatch");
    await ports.confirmSpikeResultAudit(work, result);
    work.result = result;
    await save();
  }
  const latest = new Map<string, VerifiedSpikeEvidence>();
  const attempts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const work of checkpoint.work) {
    if (work.kind !== "spike" || !work.blockerId) continue;
    attempts[work.blockerId] = Math.max(attempts[work.blockerId] ?? 0, work.attempt);
    if (work.result) latest.set(work.blockerId, work.result);
  }
  const decision = evaluateReadiness({ ...context, evidence: [...latest.values()], executors: await ports.currentExecutors(), attempts });
  checkpoint.decision = decision;
  await save();
  await ports.reconcileReadinessLabels(state.issue, decision);
  if (decision.action !== "implement" && decision.action !== "spike") return decision;
  const attempt = decision.blockerId ? (attempts[decision.blockerId] ?? 0) + 1 : 1;
  const work: ReadinessWork = {
    key: key([state.repository, state.runId, context.revision, decision.action, decision.blockerId ?? "", attempt]),
    revision: context.revision, kind: decision.action === "spike" ? "spike" : "implementation",
    executorId: decision.executorId!, blockerId: decision.blockerId, attempt,
  };
  checkpoint.work.push(work);
  await save();
  if (!await resume(work)) {
    const waiting = { action: "await-executor" as const, reason: "executor-became-unavailable", blockerId: work.blockerId };
    checkpoint.decision = waiting;
    await save();
    await ports.reconcileReadinessLabels(state.issue, waiting);
    return waiting;
  }
  return { action: "observe-work", reason: `${work.kind}-dispatched`, workKey: work.key };
}
