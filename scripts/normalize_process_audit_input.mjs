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
  FIELD_MAX_LENGTHS,
  ARRAY_MAX_LENGTHS,
  ARRAY_ELEMENT_MAX_LENGTHS,
  rejectSecrets,
  rejectSecretsInArray,
  validateCanonicalUtcTimestamp,
  validateRepositoryFormat,
  validateEvidenceUrl,
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

  // --- required string fields (presence + non-empty + secret scan) ----------
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
    // Per-field maximum length
    const maxLen = FIELD_MAX_LENGTHS[field];
    if (maxLen !== undefined && val.length > maxLen) {
      throw new Error(
        `SPEC-005 validation failed: '${field}' must not exceed ${maxLen} characters (got ${val.length}).`,
      );
    }
  }

  // --- occurred_at: canonical UTC -------------------------------------------
  validateCanonicalUtcTimestamp(raw["occurred_at"], "occurred_at");

  // --- repository: must be owner/repo format --------------------------------
  validateRepositoryFormat(raw["repository"], "repository");

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

  // Array length bounds
  for (const [field, maxCount] of Object.entries(ARRAY_MAX_LENGTHS)) {
    if (Array.isArray(raw[field]) && raw[field].length > maxCount) {
      throw new Error(
        `SPEC-005 validation failed: '${field}' must not have more than ${maxCount} elements (got ${raw[field].length}).`,
      );
    }
  }

  rejectSecretsInArray(raw["supporting_access_roles"], "supporting_access_roles");
  rejectSecretsInArray(raw["correlation_ids"], "correlation_ids");
  rejectSecretsInArray(raw["evidence"], "evidence");

  // Per-element length bounds
  for (const field of ["supporting_access_roles", "correlation_ids", "evidence"]) {
    const maxElemLen = ARRAY_ELEMENT_MAX_LENGTHS[field];
    if (maxElemLen === undefined) continue;
    for (let i = 0; i < raw[field].length; i++) {
      const elem = raw[field][i];
      if (typeof elem === "string" && elem.length > maxElemLen) {
        throw new Error(
          `SPEC-005 validation failed: '${field}[${i}]' must not exceed ${maxElemLen} characters (got ${elem.length}).`,
        );
      }
    }
  }

  // Each element of supporting_access_roles must be a known access-role enum value.
  for (const role of raw["supporting_access_roles"]) {
    if (typeof role !== "string" || !ALLOWED_ACCESS_ROLES.has(role)) {
      throw new Error(
        `SPEC-005 validation failed: 'supporting_access_roles' contains unknown value '${role}'. ` +
        `Each element must be one of [${[...ALLOWED_ACCESS_ROLES].join(", ")}].`,
      );
    }
  }

  // Each element of correlation_ids must be a string
  for (let i = 0; i < raw["correlation_ids"].length; i++) {
    if (typeof raw["correlation_ids"][i] !== "string") {
      throw new Error(
        `SPEC-005 validation failed: 'correlation_ids[${i}]' must be a string.`,
      );
    }
  }

  // Evidence items must be valid HTTPS URLs without userinfo/query/fragment.
  for (let i = 0; i < raw["evidence"].length; i++) {
    const item = raw["evidence"][i];
    if (typeof item !== "string") {
      throw new Error(
        `SPEC-005 validation failed: 'evidence[${i}]' must be a string.`,
      );
    }
    validateEvidenceUrl(item, `evidence[${i}]`);
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
