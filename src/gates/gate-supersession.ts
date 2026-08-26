import { resolveGate } from "../state/state-machine.js";
import type { GateRecord, RunState } from "../state/types.js";

export type GateSupersessionClassification = "automation-false-positive" | "operator-false-positive";

export interface GateSupersessionInput {
  gateId: string;
  idempotencyKey: string;
  classification: GateSupersessionClassification;
  reason: string;
  description: string;
  actor: string;
  accessRole: string;
  evidence: string[];
  occurredAt?: string;
}

export interface GateSupersessionAuditEnvelope {
  schema_version: 1;
  occurred_at: string;
  process_instance: string;
  idempotency_key: string;
  process_code: "PROCESS_RECONCILIATION";
  actor: string;
  access_role: string;
  supporting_access_roles: string[];
  outcome: "SUPERSEDED";
  repository: string;
  artifact: string;
  correlation_ids: string[];
  evidence: string[];
  reason: string;
  description: string;
}

const PROTECTED_GATE_PATTERN = /(approval|merge|security|risk|cost|migration|production|deployment|spec)/i;

const CANONICAL_ACTORS = new Set([
  "GITHUB_ACTIONS", "COPILOT", "HUMAN", "GITHUB_COPILOT", "HUMAN_PRODUCT_OWNER",
  "HUMAN_DEVELOPER", "CODEX", "VERCEL", "NEON", "MAKE", "N8N",
  "IMMOGENT_APPLICATION", "EXTERNAL_SYSTEM",
]);

const CANONICAL_ACCESS_ROLES = new Set([
  "GITHUB_ACTIONS_TOKEN", "PERSONAL_ACCESS_TOKEN", "APP_INSTALLATION_TOKEN",
  "HUMAN_BROWSER_SESSION", "GITHUB_PERSONAL_ACCESS_TOKEN", "LOCAL_WORKSPACE",
  "GITHUB_APP_USER_AUTHORIZATION", "GITHUB_COPILOT_AGENT_IDENTITY", "CODEX_CHAT_SESSION",
  "PERSONAL_BROWSER_SESSION", "SYSTEM_SERVICE_IDENTITY", "VERCEL_ACCOUNT_SESSION",
  "VERCEL_AUTOMATION_BYPASS", "NEON_ACCOUNT_SESSION", "MAKE_ACCOUNT_SESSION",
  "N8N_SERVICE_CREDENTIAL", "WEBHOOK_HMAC_IDENTITY", "ANONYMOUS_READ_ONLY",
]);

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function validateCandidate(gate: GateRecord, input: GateSupersessionInput): void {
  if (gate.type !== "human") throw new Error(`gate '${gate.id}' is not a human gate`);
  if (gate.result !== "pending" && gate.result !== "needs-human" && gate.result !== "superseded") {
    throw new Error(`gate '${gate.id}' is already decided as '${gate.result}'`);
  }
  if (PROTECTED_GATE_PATTERN.test(gate.id)) {
    throw new Error(
      `gate '${gate.id}' is protected and cannot be superseded; product, security, cost, spec, production and SHA-bound merge decisions require their canonical decision path`,
    );
  }
  requireText(input.idempotencyKey, "idempotency key");
  requireText(input.reason, "reason");
  requireText(input.description, "description");
  requireText(input.actor, "actor");
  requireText(input.accessRole, "access role");
  if (!CANONICAL_ACTORS.has(input.actor)) throw new Error(`actor '${input.actor}' is not canonical`);
  if (!CANONICAL_ACCESS_ROLES.has(input.accessRole)) {
    throw new Error(`access role '${input.accessRole}' is not canonical`);
  }
  if (input.evidence.length === 0 || input.evidence.some((item) => !item.trim())) {
    throw new Error("at least one non-empty evidence item is required");
  }
}

/** Pure durable checkpoint. Persist this result before audit dispatch or label cleanup. */
export function prepareGateSupersession(state: RunState, input: GateSupersessionInput): RunState {
  const gate = state.gates.find((candidate) => candidate.id === input.gateId);
  if (!gate) throw new Error(`unknown gate '${input.gateId}' on run '${state.runId}'`);
  validateCandidate(gate, input);
  if (gate.supersession) {
    if (gate.supersession.idempotencyKey !== input.idempotencyKey) {
      throw new Error(
        `gate '${input.gateId}' was already superseded with idempotency key '${gate.supersession.idempotencyKey}'`,
      );
    }
    const sameRequest =
      gate.supersession.classification === input.classification &&
      gate.supersession.reason === input.reason.trim() &&
      gate.supersession.description === input.description.trim() &&
      gate.supersession.actor === input.actor.trim() &&
      gate.supersession.accessRole === input.accessRole.trim() &&
      JSON.stringify(gate.supersession.evidence) === JSON.stringify(input.evidence.map((item) => item.trim()));
    if (!sameRequest) {
      throw new Error(`idempotency key '${input.idempotencyKey}' was reused with a different supersession payload`);
    }
    return state;
  }
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  return resolveGate(state, input.gateId, {
    result: "superseded",
    cleanupPending: true,
    evidence: [...new Set([...(gate.evidence ?? []), ...input.evidence])],
    supersession: {
      idempotencyKey: input.idempotencyKey.trim(),
      classification: input.classification,
      reason: input.reason.trim(),
      description: input.description.trim(),
      actor: input.actor.trim(),
      accessRole: input.accessRole.trim(),
      evidence: input.evidence.map((item) => item.trim()),
      occurredAt,
      auditStatus: "prepared",
    },
  });
}

export function buildGateSupersessionAuditEnvelope(options: {
  state: RunState;
  gateId: string;
  processInstance: string;
  trackingIssueNumber: number;
  trackingIssueUrl: string;
}): GateSupersessionAuditEnvelope {
  const gate = options.state.gates.find((candidate) => candidate.id === options.gateId);
  if (!gate?.supersession) throw new Error(`gate '${options.gateId}' has no prepared supersession`);
  return {
    schema_version: 1,
    occurred_at: gate.supersession.occurredAt,
    process_instance: options.processInstance,
    idempotency_key: gate.supersession.idempotencyKey,
    process_code: "PROCESS_RECONCILIATION",
    actor: gate.supersession.actor,
    access_role: gate.supersession.accessRole,
    supporting_access_roles: [],
    outcome: "SUPERSEDED",
    repository: options.state.repository,
    artifact: `${options.trackingIssueUrl}#gate-${options.gateId}`,
    correlation_ids: [
      options.state.runId,
      `gate:${options.gateId}`,
      `tracking-issue:${options.trackingIssueNumber}`,
    ],
    evidence: gate.supersession.evidence,
    reason: gate.supersession.reason,
    description: gate.supersession.description,
  };
}

/** Pure audit-confirmation checkpoint. Persist before external cleanup. */
export function confirmGateSupersessionAudit(
  state: RunState,
  gateId: string,
  idempotencyKey: string,
  confirmedAt: string,
): RunState {
  const gate = state.gates.find((candidate) => candidate.id === gateId);
  if (!gate?.supersession || gate.supersession.idempotencyKey !== idempotencyKey) {
    throw new Error(`gate '${gateId}' has no matching prepared supersession`);
  }
  if (gate.supersession.auditStatus === "confirmed") return state;
  return resolveGate(state, gateId, {
    supersession: { ...gate.supersession, auditStatus: "confirmed", auditConfirmedAt: confirmedAt },
  });
}

/** Pure final checkpoint after idempotent comment and label cleanup. */
export function completeGateSupersession(state: RunState, gateId: string, completedAt?: string): RunState {
  const gate = state.gates.find((candidate) => candidate.id === gateId);
  if (!gate?.supersession || gate.supersession.auditStatus !== "confirmed") {
    throw new Error(`gate '${gateId}' supersession audit is not confirmed`);
  }
  if (!gate.cleanupPending && gate.supersession.completedAt) return state;
  return resolveGate(state, gateId, {
    cleanupPending: false,
    supersession: { ...gate.supersession, completedAt: completedAt ?? new Date().toISOString() },
  });
}
