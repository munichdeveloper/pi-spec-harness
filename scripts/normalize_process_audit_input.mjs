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

// ---------------------------------------------------------------------------
// Allowed enum values
// ---------------------------------------------------------------------------

const ALLOWED_PROCESS_CODES = new Set([
  "PR_MERGE",
  "SPEC_TO_ISSUE",
  "GATE_APPROVED",
  "GATE_REJECTED",
  "DOCUMENTATION_UPDATE",
  "CAPABILITY_SMOKE",
  "BUG_TO_PR",
]);

const ALLOWED_OUTCOMES = new Set(["SUCCEEDED", "FAILED", "SKIPPED"]);

const ALLOWED_ACTORS = new Set([
  "GITHUB_ACTIONS",
  "COPILOT",
  "HUMAN",
]);

const ALLOWED_ACCESS_ROLES = new Set([
  "GITHUB_ACTIONS_TOKEN",
  "PERSONAL_ACCESS_TOKEN",
  "APP_INSTALLATION_TOKEN",
  "HUMAN_BROWSER_SESSION",
]);

// ---------------------------------------------------------------------------
// Secret-pattern rejection (SPEC-005 §security)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9]{36,}/,        // GitHub personal access token
  /ghs_[A-Za-z0-9]{36,}/,        // GitHub server-to-server token
  /gho_[A-Za-z0-9]{36,}/,        // GitHub OAuth token
  /github_pat_[A-Za-z0-9_]{50,}/,// GitHub fine-grained PAT
  /sk-[A-Za-z0-9]{32,}/,         // OpenAI-style secret key
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, // JWT
];

function rejectSecrets(value, fieldName) {
  if (typeof value !== "string") return;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(value)) {
      throw new Error(
        `SPEC-005 validation failed: field '${fieldName}' contains a secret-like pattern and cannot be recorded.`,
      );
    }
  }
  // Double-quote characters would break YAML-quoted scalar serialisation and
  // could cause idempotency marker mismatches — reject them outright.
  if (value.includes('"')) {
    throw new Error(
      `SPEC-005 validation failed: field '${fieldName}' must not contain double-quote characters.`,
    );
  }
}

function rejectSecretsInArray(arr, fieldName) {
  if (!Array.isArray(arr)) return;
  for (const item of arr) {
    rejectSecrets(item, fieldName);
  }
}

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
