/** SPEC-016: pure decisions only. Evidence and policy require trusted adapters. */
export type ReadinessAction = "await-approval" | "classify" | "human-decision" | "spike" | "await-executor" | "implement";
export interface ReadinessBlocker {
  id: string;
  stage: "implementation" | "deployment" | "deferred";
  kind: "technical" | "decision";
  owner: string;
  question: string;
  criteria: string[];
  maxAttempts: number;
}
export interface ReadinessContract {
  schemaVersion: 1;
  specRevision: string;
  blockers: ReadinessBlocker[];
}
export interface VerifiedSpikeEvidence {
  blockerId: string;
  specRevision: string;
  verdict: "passed" | "failed";
  verifiedCriteria: string[];
  references: string[];
  changes: Array<"scope" | "cost" | "privacy">;
}
export interface ExecutorPolicy {
  id: string;
  authorized: boolean;
  available: boolean;
  capabilities: Array<"spike" | "implementation">;
  maxTaskCost: number;
}
export interface ReadinessDecision {
  action: ReadinessAction;
  reason: string;
  blockerId?: string;
  executorId?: string;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Runtime guard: input originates in a document, not in a TypeScript caller. */
export function isReadinessContract(value: unknown): value is ReadinessContract {
  if (!value || typeof value !== "object") return false;
  const contract = value as Partial<ReadinessContract>;
  if (contract.schemaVersion !== 1 || !nonempty(contract.specRevision) || !Array.isArray(contract.blockers)) return false;
  const ids = new Set<string>();
  return contract.blockers.every(blocker => {
    if (!blocker || typeof blocker !== "object" || !nonempty(blocker.id) || ids.has(blocker.id)) return false;
    ids.add(blocker.id);
    return ["implementation", "deployment", "deferred"].includes(blocker.stage)
      && ["technical", "decision"].includes(blocker.kind)
      && nonempty(blocker.owner) && nonempty(blocker.question)
      && Number.isSafeInteger(blocker.maxAttempts) && blocker.maxAttempts > 0
      && Array.isArray(blocker.criteria) && blocker.criteria.length > 0
      && blocker.criteria.every(nonempty) && new Set(blocker.criteria).size === blocker.criteria.length;
  });
}

export function evaluateReadiness(input: {
  approved: boolean;
  revision: string;
  contract: unknown;
  evidence: VerifiedSpikeEvidence[];
  executors: ExecutorPolicy[];
  costCeiling: number;
  attempts: Record<string, number>;
}): ReadinessDecision {
  if (input.approved !== true) return { action: "await-approval", reason: "spec-not-approved" };
  if (!isReadinessContract(input.contract) || input.contract.specRevision !== input.revision) {
    return { action: "classify", reason: "missing-invalid-or-stale-readiness-contract" };
  }
  const pending: ReadinessBlocker[] = [];
  for (const blocker of input.contract.blockers.filter(b => b.stage === "implementation")) {
    if (blocker.kind === "decision") return { action: "human-decision", reason: "open-product-decision", blockerId: blocker.id };
    const matching = input.evidence.filter(e => e.blockerId === blocker.id && e.specRevision === input.revision);
    if (matching.length > 1) return { action: "human-decision", reason: "ambiguous-spike-evidence", blockerId: blocker.id };
    const evidence = matching[0];
    if (evidence?.changes.length) return { action: "human-decision", reason: "spike-changes-approved-boundary", blockerId: blocker.id };
    if (evidence?.verdict === "passed" && evidence.references.length > 0 && evidence.references.every(nonempty)
      && blocker.criteria.every(c => evidence.verifiedCriteria.includes(c))) continue;
    const attempts = Object.hasOwn(input.attempts, blocker.id) ? input.attempts[blocker.id] : 0;
    if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts >= blocker.maxAttempts) {
      return { action: "human-decision", reason: "spike-attempt-budget-exhausted-or-invalid", blockerId: blocker.id };
    }
    pending.push(blocker);
  }
  const capability = pending.length ? "spike" : "implementation";
  const eligible = input.executors.filter(e => nonempty(e.id) && e.authorized === true && e.available === true
    && e.capabilities.includes(capability) && Number.isFinite(e.maxTaskCost) && e.maxTaskCost >= 0
    && Number.isFinite(input.costCeiling) && input.costCeiling >= 0 && e.maxTaskCost <= input.costCeiling);
  if (new Set(input.executors.map(e => e.id)).size !== input.executors.length) {
    return { action: "await-executor", reason: "ambiguous-executor-policy" };
  }
  if (!eligible.length) return { action: "await-executor", reason: `no-authorized-available-${capability}-executor`, blockerId: pending[0]?.id };
  return pending.length
    ? { action: "spike", reason: "technical-prerequisite", blockerId: pending[0].id, executorId: eligible[0].id }
    : { action: "implement", reason: "readiness-and-execution-policy-satisfied", executorId: eligible[0].id };
}
