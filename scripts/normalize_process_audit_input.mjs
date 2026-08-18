/**
 * SPEC-005 envelope-v1 normalization and validation.
 *
 * Accepts the nested `client_payload.audit` object (envelope-v1 format) and
 * returns a validated, normalized internal representation.  Throws with a
 * descriptive message for any validation failure.  No field values are ever
 * interpolated into shell commands or YAML strings at this layer.
 *
 * Canonical 15-field envelope (SPEC-005 §external-contract):
 *   schema_version, occurred_at, process_instance, idempotency_key,
 *   process_code, actor, access_role, supporting_access_roles, outcome,
 *   repository, artifact, correlation_ids, evidence, reason, description
 */

import {
  ALLOWED_PROCESS_CODES,
  ALLOWED_OUTCOMES,
  ALLOWED_ACTORS,
  ALLOWED_ACCESS_ROLES,
  rejectSecrets,
  rejectSecretsInArray,
} from "./process_audit_support.mjs";

// Re-export canonical enums so importers can validate/display the allowed sets
// without importing process_audit_support directly.
export { ALLOWED_PROCESS_CODES, ALLOWED_OUTCOMES, ALLOWED_ACTORS, ALLOWED_ACCESS_ROLES };

// ---------------------------------------------------------------------------
// Core validation
// ---------------------------------------------------------------------------

/**
 * Validate and normalize a SPEC-005 envelope-v1 audit payload.
 *
 * @param {unknown} raw  The value of `client_payload.audit` from the dispatch.
 * @returns {object}     Validated and normalized envelope fields.
 * @throws {Error}       If any required field is missing, has an unexpected
 *                       type, contains a disallowed enum, or matches a secret
 *                       pattern.
 */
export function normalizeProcessAuditInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("SPEC-005 validation failed: payload must be a non-null object.");
  }

  // --- schema_version -------------------------------------------------------
  if (raw["schema_version"] !== 1) {
    throw new Error(
      `SPEC-005 validation failed: 'schema_version' must be 1, got ${JSON.stringify(raw["schema_version"])}.`,
    );
  }

  // --- required string fields -----------------------------------------------
  const stringFields = [
    "occurred_at",
    "process_instance",
    "idempotency_key",
    "process_code",
    "actor",
    "access_role",
    "outcome",
    "repository",
    "artifact",
    "reason",
    "description",
  ];
  for (const field of stringFields) {
    const val = raw[field];
    if (typeof val !== "string" || val.length === 0) {
      throw new Error(
        `SPEC-005 validation failed: '${field}' must be a non-empty string, got ${JSON.stringify(val)}.`,
      );
    }
    rejectSecrets(val, field);
  }

  // --- occurred_at: must be ISO 8601 UTC -----------------------------------
  const occurredAt = raw["occurred_at"];
  const parsedDate = new Date(occurredAt);
  if (isNaN(parsedDate.getTime())) {
    throw new Error(
      `SPEC-005 validation failed: 'occurred_at' is not a valid ISO 8601 timestamp: ${JSON.stringify(occurredAt)}.`,
    );
  }

  // --- enum fields ----------------------------------------------------------
  if (!ALLOWED_PROCESS_CODES.has(raw["process_code"])) {
    throw new Error(
      `SPEC-005 validation failed: 'process_code' value '${raw["process_code"]}' is not in the allowed set ` +
      `[${[...ALLOWED_PROCESS_CODES].join(", ")}].`,
    );
  }
  if (!ALLOWED_OUTCOMES.has(raw["outcome"])) {
    throw new Error(
      `SPEC-005 validation failed: 'outcome' value '${raw["outcome"]}' is not in the allowed set ` +
      `[${[...ALLOWED_OUTCOMES].join(", ")}].`,
    );
  }
  if (!ALLOWED_ACTORS.has(raw["actor"])) {
    throw new Error(
      `SPEC-005 validation failed: 'actor' value '${raw["actor"]}' is not in the allowed set ` +
      `[${[...ALLOWED_ACTORS].join(", ")}].`,
    );
  }
  if (!ALLOWED_ACCESS_ROLES.has(raw["access_role"])) {
    throw new Error(
      `SPEC-005 validation failed: 'access_role' value '${raw["access_role"]}' is not in the allowed set ` +
      `[${[...ALLOWED_ACCESS_ROLES].join(", ")}].`,
    );
  }

  // --- array fields ---------------------------------------------------------
  if (!Array.isArray(raw["supporting_access_roles"])) {
    throw new Error("SPEC-005 validation failed: 'supporting_access_roles' must be an array.");
  }
  if (!Array.isArray(raw["correlation_ids"])) {
    throw new Error("SPEC-005 validation failed: 'correlation_ids' must be an array.");
  }
  if (!Array.isArray(raw["evidence"])) {
    throw new Error("SPEC-005 validation failed: 'evidence' must be an array.");
  }
  rejectSecretsInArray(raw["supporting_access_roles"], "supporting_access_roles");
  rejectSecretsInArray(raw["correlation_ids"], "correlation_ids");
  rejectSecretsInArray(raw["evidence"], "evidence");

  // Each element of supporting_access_roles must be a known access-role enum
  // value (not just a safe string). This prevents arbitrary strings from
  // bypassing the access-role contract. SPEC-005 §external-contract.
  for (const role of raw["supporting_access_roles"]) {
    if (typeof role !== "string" || !ALLOWED_ACCESS_ROLES.has(role)) {
      throw new Error(
        `SPEC-005 validation failed: 'supporting_access_roles' contains unknown value '${role}'. ` +
        `Each element must be one of [${[...ALLOWED_ACCESS_ROLES].join(", ")}].`,
      );
    }
  }

  // --- no extra top-level fields that could smuggle data --------------------
  const ALLOWED_FIELDS = new Set([
    "schema_version", "occurred_at", "process_instance", "idempotency_key",
    "process_code", "actor", "access_role", "supporting_access_roles",
    "outcome", "repository", "artifact", "correlation_ids", "evidence",
    "reason", "description",
  ]);
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new Error(
        `SPEC-005 validation failed: unexpected field '${key}' in envelope payload. ` +
        `Only the 15 canonical fields are accepted.`,
      );
    }
  }

  return {
    schema_version: 1,
    occurred_at: raw["occurred_at"],
    process_instance: raw["process_instance"],
    idempotency_key: raw["idempotency_key"],
    process_code: raw["process_code"],
    actor: raw["actor"],
    access_role: raw["access_role"],
    supporting_access_roles: raw["supporting_access_roles"],
    outcome: raw["outcome"],
    repository: raw["repository"],
    artifact: raw["artifact"],
    correlation_ids: raw["correlation_ids"],
    evidence: raw["evidence"],
    reason: raw["reason"],
    description: raw["description"],
  };
}
