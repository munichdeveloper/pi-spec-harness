import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildGateSupersessionAuditEnvelope,
  completeGateSupersession,
  confirmGateSupersessionAudit,
  prepareGateSupersession,
} from "../src/gates/gate-supersession.js";
import { initRunState, resolveGate, upsertGate } from "../src/state/state-machine.js";

function openGate(id = "agent-assign-unverified") {
  let state = initRunState({
    runId: "issue-70",
    repository: "munichdeveloper/pi-spec-harness",
    requirement: "REQ-011",
    spec: "SPEC-011",
  });
  state = upsertGate(state, { id, type: "human", question: "False-positive assignment gate" });
  return resolveGate(state, id, { result: "needs-human", cleanupPending: false });
}

const input = {
  gateId: "agent-assign-unverified",
  idempotencyKey: "gate-supersede:issue-70:agent-assign-unverified:v1",
  classification: "automation-false-positive" as const,
  reason: "The obsolete assignment attempt conflicts with the corrected responsibility model.",
  description: "Preserve the gate and unblock only after the canonical audit is confirmed.",
  actor: "CODEX",
  accessRole: "CODEX_CHAT_SESSION",
  evidence: ["https://github.com/munichdeveloper/pi-spec-harness/issues/82"],
  occurredAt: "2026-08-26T10:00:00.000Z",
};

describe("audited canonical gate supersession", () => {
  it("preserves the original gate with a terminal superseded disposition and no human decision", () => {
    const state = prepareGateSupersession(openGate(), input);
    const gate = state.gates[0];
    expect(gate.result).toBe("superseded");
    expect(gate.decision).toBeUndefined();
    expect(gate.cleanupPending).toBe(true);
    expect(gate.supersession).toMatchObject({
      idempotencyKey: input.idempotencyKey,
      classification: "automation-false-positive",
      auditStatus: "prepared",
    });
  });

  it("is a no-op when retried with the same idempotency key", () => {
    const prepared = prepareGateSupersession(openGate(), input);
    expect(prepareGateSupersession(prepared, input)).toBe(prepared);
  });

  it("rejects a second identity for an already prepared supersession", () => {
    const prepared = prepareGateSupersession(openGate(), input);
    expect(() => prepareGateSupersession(prepared, { ...input, idempotencyKey: "different" }))
      .toThrow(/already superseded/);
    expect(() => prepareGateSupersession(prepared, { ...input, reason: "different reason" }))
      .toThrow(/different supersession payload/);
  });

  it("requires structured evidence and rejects protected decision gates", () => {
    expect(() => prepareGateSupersession(openGate(), { ...input, evidence: [] })).toThrow(/evidence/);
    expect(() => prepareGateSupersession(openGate(), { ...input, actor: "UNKNOWN" })).toThrow(/actor/);
    expect(() => prepareGateSupersession(openGate(), { ...input, accessRole: "ROOT" })).toThrow(/access role/);
    expect(() => prepareGateSupersession(openGate("merge-approval-pr81-sha123"), {
      ...input,
      gateId: "merge-approval-pr81-sha123",
    })).toThrow(/protected/);
  });

  it("cannot be consumed by the generic human-decision cleanup path", async () => {
    const { findPendingGateCleanup } = await import("../src/state/state-machine.js");
    const prepared = prepareGateSupersession(openGate(), input);
    expect(findPendingGateCleanup(prepared)).toBeUndefined();
  });

  it("requires audit confirmation before cleanup can complete", () => {
    const prepared = prepareGateSupersession(openGate(), input);
    expect(() => completeGateSupersession(prepared, input.gateId)).toThrow(/audit is not confirmed/);
    const confirmed = confirmGateSupersessionAudit(
      prepared,
      input.gateId,
      input.idempotencyKey,
      "2026-08-26T10:01:00.000Z",
    );
    expect(confirmed.gates[0].cleanupPending).toBe(true);
    const completed = completeGateSupersession(confirmed, input.gateId, "2026-08-26T10:02:00.000Z");
    expect(completed.gates[0].cleanupPending).toBe(false);
    expect(completed.gates[0].supersession?.completedAt).toBe("2026-08-26T10:02:00.000Z");
  });

  it("builds the complete 15-field SPEC-005 audit envelope", () => {
    const prepared = prepareGateSupersession(openGate(), input);
    const envelope = buildGateSupersessionAuditEnvelope({
      state: prepared,
      gateId: input.gateId,
      processInstance: "PI-MUNICHDEVELOPER-PI-SPEC-HARNESS-RUN-0080",
      trackingIssueNumber: 80,
      trackingIssueUrl: "https://github.com/munichdeveloper/pi-spec-harness/issues/80",
    });
    expect(Object.keys(envelope).sort()).toEqual([
      "access_role", "actor", "artifact", "correlation_ids", "description", "evidence",
      "idempotency_key", "occurred_at", "outcome", "process_code", "process_instance",
      "reason", "repository", "schema_version", "supporting_access_roles",
    ].sort());
    expect(envelope).toMatchObject({
      process_code: "PROCESS_RECONCILIATION",
      outcome: "SUPERSEDED",
      actor: "CODEX",
      access_role: "CODEX_CHAT_SESSION",
      idempotency_key: input.idempotencyKey,
    });
  });

  it("resumes safely from the audit-confirmed crash checkpoint", () => {
    const prepared = prepareGateSupersession(openGate(), input);
    const confirmed = confirmGateSupersessionAudit(
      prepared,
      input.gateId,
      input.idempotencyKey,
      "2026-08-26T10:01:00.000Z",
    );
    const retried = prepareGateSupersession(confirmed, input);
    expect(retried).toBe(confirmed);
    expect(completeGateSupersession(retried, input.gateId).gates[0].cleanupPending).toBe(false);
  });

  it("persists correction and audit confirmation before external cleanup", async () => {
    const source = await readFile("src/cli.ts", "utf8");
    const start = source.indexOf("export async function cmdGateSupersede");
    const end = source.indexOf("async function cmdPhase", start);
    const command = source.slice(start, end);
    const correctionSave = command.indexOf("await store.save(state)");
    const dispatch = command.indexOf("dispatchProcessAuditEnvelopeV1");
    const confirmationSave = command.indexOf("await store.save(state)", dispatch);
    const cleanup = command.indexOf("await github.removeLabels");
    expect(correctionSave).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(correctionSave);
    expect(confirmationSave).toBeGreaterThan(dispatch);
    expect(cleanup).toBeGreaterThan(confirmationSave);
  });
});
