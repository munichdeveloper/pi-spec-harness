/**
 * Shared SPEC-005 process audit support: canonical enums, secret-pattern
 * rejection, timestamp normalisation, URL validation, and safe YAML
 * serialisation for audit journal files.
 *
 * This module is imported by both `normalize_process_audit_input.mjs` and
 * `record_process_audit.mjs` so that enum parity, validation rules, and
 * serialisation behaviour are always in sync.
 *
 * SPEC-005 §external-contract / §security.
 */

import { URL } from "node:url";

// ---------------------------------------------------------------------------
// Canonical enum sets (SPEC-005 §external-contract)
// ---------------------------------------------------------------------------

/**
 * Canonical set of allowed `process_code` values.
 *
 * Mirrors the full docs/50-quality/process-audit/enums/process-step.md set
 * from the Immogent repository.  No legacy aliases are maintained here —
 * callers must use the canonical form.
 */
export const ALLOWED_PROCESS_CODES = new Set([
  // Requirement lifecycle
  "REQUIREMENT_CREATE",
  "REQUIREMENT_UPDATE",
  "REQUIREMENT_ARCHIVE",

  // Specification lifecycle
  "SPEC_CREATE",
  "SPEC_UPDATE",
  "SPEC_ARCHIVE",
  "SPEC_TO_ISSUE",

  // Human-gate lifecycle
  "GATE_OPEN",
  "GATE_APPROVED",
  "GATE_REJECTED",
  "GATE_ESCALATE",

  // Agent / iteration lifecycle
  "AGENT_TASK_START",
  "AGENT_TASK_FINISH",
  "ITERATION_START",
  "ITERATION_FINISH",

  // Implementation lifecycle
  "IMPLEMENTATION_START",
  "IMPLEMENTATION_FINISH",

  // CI / quality lifecycle
  "CI_TRIGGER",
  "CI_JOB_START",
  "CI_JOB_COMPLETE",
  "CI_FAILURE",
  "CI_VERIFICATION",
  "TEST_EXECUTION",

  // Preview lifecycle
  "PREVIEW_DEPLOY",
  "PREVIEW_VERIFY",
  "PREVIEW_TEARDOWN",

  // Database migration lifecycle
  "DB_MIGRATION_RUN",
  "DB_ROLLBACK_RUN",

  // Pull-request lifecycle
  "PR_OPEN",
  "PR_APPROVE",
  "PR_CLOSE",
  "PR_MERGE",
  "BUG_TO_PR",

  // Production deployment lifecycle
  "PRODUCTION_DEPLOY",
  "PRODUCTION_ROLLBACK",
  "PRODUCTION_VERIFY",

  // Incident management
  "INCIDENT_CREATE",
  "INCIDENT_RESOLVE",
  "INCIDENT_CLOSE",

  // Manual / ad-hoc actions
  "MANUAL_ACTION",
  "MANUAL_OVERRIDE",

  // Reconciliation
  "RECONCILIATION_START",
  "RECONCILIATION_COMPLETE",

  // Issue and review lifecycle (issue tracker)
  "ISSUE_CREATE",
  "CODE_REVIEW",
  "REVIEW_COMMENT_CREATE",
  "REVIEW_FINDING_RESOLVE",

  // Documentation and harness-internal
  "DOCUMENTATION_UPDATE",
  "CAPABILITY_SMOKE",
]);

/**
 * Canonical set of allowed `outcome` values.
 */
export const ALLOWED_OUTCOMES = new Set([
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "STARTED",
  "BLOCKED",
  "PARTIAL",
  "REJECTED",
  "SUPERSEDED",
]);

/**
 * Canonical set of allowed `actor` values.
 */
export const ALLOWED_ACTORS = new Set([
  "GITHUB_ACTIONS",
  "COPILOT",
  "HUMAN",
  "GITHUB_COPILOT",
  "HUMAN_PRODUCT_OWNER",
  "HUMAN_DEVELOPER",
  "CODEX",
  "VERCEL",
  "NEON",
  "MAKE",
  "N8N",
  "IMMOGENT_APPLICATION",
  "EXTERNAL_SYSTEM",
]);

/**
 * Canonical set of allowed `access_role` and `supporting_access_roles`
 * element values.
 */
export const ALLOWED_ACCESS_ROLES = new Set([
  "GITHUB_ACTIONS_TOKEN",
  "PERSONAL_ACCESS_TOKEN",
  "APP_INSTALLATION_TOKEN",
  "HUMAN_BROWSER_SESSION",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "LOCAL_WORKSPACE",
  "GITHUB_APP_USER_AUTHORIZATION",
  "GITHUB_COPILOT_AGENT_IDENTITY",
  "CODEX_CHAT_SESSION",
  "PERSONAL_BROWSER_SESSION",
  "SYSTEM_SERVICE_IDENTITY",
  "VERCEL_ACCOUNT_SESSION",
  "VERCEL_AUTOMATION_BYPASS",
  "NEON_ACCOUNT_SESSION",
  "MAKE_ACCOUNT_SESSION",
  "N8N_SERVICE_CREDENTIAL",
  "WEBHOOK_HMAC_IDENTITY",
  "ANONYMOUS_READ_ONLY",
]);

// ---------------------------------------------------------------------------
// Secret-pattern rejection (SPEC-005 §security)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9]{36,}/,         // GitHub personal access token
  /ghs_[A-Za-z0-9]{36,}/,         // GitHub server-to-server token
  /gho_[A-Za-z0-9]{36,}/,         // GitHub OAuth token
  /github_pat_[A-Za-z0-9_]{50,}/, // GitHub fine-grained PAT
  /sk-[A-Za-z0-9]{32,}/,          // OpenAI-style secret key
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, // JWT
];

/**
 * Reject strings that look like secrets, contain YAML-unsafe characters, or
 * could inject structure into double-quoted YAML scalars.
 *
 * Rejected characters:
 *   - Secret-pattern matches (tokens, JWTs)
 *   - Double-quote (`"`): breaks quoted scalar boundaries
 *   - Backslash (`\`): introduces YAML escape sequences
 *   - Newline (`\n`) / carriage-return (`\r`): breaks scalar boundaries
 *   - Control chars 0x00–0x08, 0x0B–0x0C, 0x0E–0x1F: unsafe in any YAML
 *
 * @param {string} value  The string to validate.
 * @param {string} fieldName  Name used in error messages.
 */
export function rejectSecrets(value, fieldName) {
  if (typeof value !== "string") return;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(value)) {
      throw new Error(
        `SPEC-005 validation failed: field '${fieldName}' contains a secret-like pattern and cannot be recorded.`,
      );
    }
  }
  if (value.includes('"')) {
    throw new Error(
      `SPEC-005 validation failed: field '${fieldName}' must not contain double-quote characters.`,
    );
  }
  if (value.includes("\\")) {
    throw new Error(
      `SPEC-005 validation failed: field '${fieldName}' must not contain backslash characters.`,
    );
  }
  if (/[\n\r]/.test(value)) {
    throw new Error(
      `SPEC-005 validation failed: field '${fieldName}' must not contain newline characters.`,
    );
  }
  // Control characters (0x00–0x08, 0x0B–0x0C, 0x0E–0x1F); tab (0x09) is
  // technically allowed in YAML but excluded here for safety.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value)) {
    throw new Error(
      `SPEC-005 validation failed: field '${fieldName}' must not contain control characters.`,
    );
  }
}

/**
 * Call {@link rejectSecrets} for every element of an array field.
 *
 * @param {unknown[]} arr  Array to validate.
 * @param {string} fieldName  Name used in error messages.
 */
export function rejectSecretsInArray(arr, fieldName) {
  if (!Array.isArray(arr)) return;
  for (const item of arr) {
    rejectSecrets(item, fieldName);
  }
}

// ---------------------------------------------------------------------------
// Field and array bounds (SPEC-005 §external-contract)
// ---------------------------------------------------------------------------

/**
 * Maximum byte length for scalar string fields.
 * @type {Record<string, number>}
 */
export const FIELD_MAX_LENGTHS = {
  process_instance: 256,
  idempotency_key: 256,
  actor: 128,
  access_role: 128,
  process_code: 64,
  outcome: 64,
  repository: 256,
  artifact: 1024,
  reason: 500,
  description: 2000,
};

/**
 * Maximum element counts for array fields.
 * @type {Record<string, number>}
 */
export const ARRAY_MAX_LENGTHS = {
  supporting_access_roles: 10,
  correlation_ids: 20,
  evidence: 20,
};

/**
 * Maximum byte length for each element in an array field.
 * @type {Record<string, number>}
 */
export const ARRAY_ELEMENT_MAX_LENGTHS = {
  supporting_access_roles: 128,
  correlation_ids: 256,
  evidence: 2048,
};

// ---------------------------------------------------------------------------
// Timestamp normalisation and validation (SPEC-005 §external-contract)
// ---------------------------------------------------------------------------

/**
 * Validate that a string is a canonical ISO 8601 UTC timestamp (ends with `Z`,
 * parseable by `new Date()`, and round-trips to the same ISO string).
 *
 * @param {string} value  The timestamp string to validate.
 * @param {string} fieldName  Name used in error messages.
 * @returns {string}  The canonical UTC form (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 * @throws {Error}  If the timestamp is not valid canonical UTC.
 */
export function validateCanonicalUtcTimestamp(value, fieldName) {
  if (typeof value !== "string") {
    throw new Error(
      `SPEC-005 validation failed: '${fieldName}' must be a string, got ${typeof value}.`,
    );
  }
  // Must end with Z (strict UTC; no offset notation like +00:00 accepted).
  if (!value.endsWith("Z")) {
    throw new Error(
      `SPEC-005 validation failed: '${fieldName}' must be a canonical UTC timestamp ending with 'Z', ` +
      `got '${value}'.`,
    );
  }
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw new Error(
      `SPEC-005 validation failed: '${fieldName}' is not a valid ISO 8601 timestamp: '${value}'.`,
    );
  }
  // Round-trip check: the canonical form produced by toISOString() always
  // includes milliseconds (e.g. "2026-08-18T22:09:10.000Z").  Input that
  // differs (e.g. "2026-08-18T22:09:10Z") is not canonical and must be
  // rejected so that stored timestamps are byte-identical to their canonical
  // representation.
  const canonical = d.toISOString();
  if (value !== canonical) {
    throw new Error(
      `SPEC-005 validation failed: '${fieldName}' must be the canonical ISO 8601 UTC form ` +
      `(as produced by Date.toISOString(), e.g. "${canonical}"), got '${value}'.`,
    );
  }
  return canonical;
}

/**
 * Normalise an ISO 8601 timestamp to the compact filename-safe form used for
 * chronologically sortable journal filenames: `YYYYMMDDTHHmmssZ` (UTC only;
 * fractional seconds stripped).
 *
 * @param {string} isoTs  ISO 8601 UTC timestamp string (e.g. `"2026-08-18T22:09:10.972Z"`).
 * @returns {string}  Compact form (e.g. `"20260818T220910Z"`).
 */
export function normalizeTimestampForFilename(isoTs) {
  return isoTs.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Repository, artifact, and evidence URL validation (SPEC-005 §external-contract)
// ---------------------------------------------------------------------------

/**
 * Validate a `repository` field: must match `owner/repo` with no slashes in
 * either component, no whitespace, and no URL scheme prefix.
 *
 * @param {string} value  The repository string to validate.
 * @param {string} fieldName  Name used in error messages.
 */
export function validateRepositoryFormat(value, fieldName) {
  if (!/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(value)) {
    throw new Error(
      `SPEC-005 validation failed: '${fieldName}' must be in 'owner/repo' format ` +
      `(only alphanumeric, dot, hyphen, underscore; max 100 chars per component), ` +
      `got '${value}'.`,
    );
  }
}

/**
 * Validate an evidence URL: must be HTTPS, no userinfo component, no query
 * string, and no fragment. These restrictions prevent leaking secrets in URLs
 * and ensure evidence remains stable references.
 *
 * @param {string} value  The URL to validate.
 * @param {string} fieldName  Name used in error messages (e.g. "evidence[0]").
 */
export function validateEvidenceUrl(value, fieldName) {
  // Detect userinfo (user:pass@host) before calling new URL() — newer URL
  // parsers (Node.js ≥ 22) reject userinfo and throw "Invalid URL", which
  // would produce a misleading "is not a valid URL" error instead.
  if (/^https?:\/\/[^/]*@/.test(value)) {
    throw new Error(
      `SPEC-005 validation failed: '${fieldName}' must not contain userinfo (username/password) in the URL.`,
    );
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `SPEC-005 validation failed: '${fieldName}' is not a valid URL: '${value}'.`,
    );
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `SPEC-005 validation failed: '${fieldName}' must use the https: scheme, got '${url.protocol}'.`,
    );
  }
  if (url.username || url.password) {
    throw new Error(
      `SPEC-005 validation failed: '${fieldName}' must not contain userinfo (username/password): '${value}'.`,
    );
  }
  if (url.search) {
    throw new Error(
      `SPEC-005 validation failed: '${fieldName}' must not contain a query string: '${value}'.`,
    );
  }
  if (url.hash) {
    throw new Error(
      `SPEC-005 validation failed: '${fieldName}' must not contain a fragment: '${value}'.`,
    );
  }
}

// ---------------------------------------------------------------------------
// YAML serialisation (SPEC-005 §security / record_process_audit)
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe embedding as a YAML double-quoted scalar.
 *
 * YAML double-quoted scalars allow `\"` and `\\` as escape sequences.  All
 * other characters that could break YAML structure are rejected upstream by
 * {@link rejectSecrets}, so by the time this function is called those
 * characters will not be present.  The function applies a complete,
 * defence-in-depth set of escape rules anyway so that it is safe even without
 * the upstream gate:
 *
 *   `\`  → `\\`   (must be first to avoid double-escaping subsequent sequences)
 *   `"`  → `\"`
 *   newline  → `\n`
 *   carriage-return  → `\r`
 *   tab  → `\t`
 *   remaining C0 controls (0x00–0x08, 0x0B–0x0C, 0x0E–0x1F)  → `\uXXXX`
 *
 * @param {string} value  The raw string value to escape.
 * @returns {string}  The escaped string, safe to embed between `"…"` in YAML.
 */
export function yamlDoubleQuoteEscape(value) {
  return value
    .replace(/\\/g, "\\\\")    // backslash first
    .replace(/"/g, '\\"')      // double-quote
    .replace(/\n/g, "\\n")     // newline
    .replace(/\r/g, "\\r")     // carriage-return
    .replace(/\t/g, "\\t")     // tab
    // remaining C0 controls
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, (c) =>
      `\\u${c.codePointAt(0).toString(16).padStart(4, "0")}`,
    );
}

/**
 * Serialise a string value as a YAML double-quoted scalar line.
 *
 * @param {string} key   YAML key (must be a safe identifier string).
 * @param {string} value  The raw string value.
 * @returns {string}  The YAML line, e.g. `process_code: "DOCUMENTATION_UPDATE"`.
 */
export function yamlStringLine(key, value) {
  return `${key}: "${yamlDoubleQuoteEscape(value)}"`;
}

/**
 * Serialise a string array as a YAML block-sequence or inline `[]`.
 *
 * @param {string} key   YAML key.
 * @param {string[]} items  Array of raw string values.
 * @returns {string}  The YAML block (may be multi-line).
 */
export function yamlStringArray(key, items) {
  if (items.length === 0) return `${key}: []`;
  const lines = items.map((v) => `  - "${yamlDoubleQuoteEscape(v)}"`).join("\n");
  return `${key}:\n${lines}`;
}

/**
 * Render a fully validated SPEC-005 envelope-v1 event object as YAML
 * frontmatter suitable for a journal `.md` file.  All string values are
 * emitted through {@link yamlStringLine} / {@link yamlStringArray} so that no
 * raw payload bytes can inject YAML structure.
 *
 * @param {object} event  Validated event from {@link normalizeProcessAuditInput}.
 * @param {string} confirmedAt  ISO 8601 timestamp when the entry was written.
 * @returns {string}  Complete `---\n…\n---` YAML frontmatter block.
 */
export function renderAuditFrontmatter(event, confirmedAt) {
  const lines = [
    "---",
    `schema_version: ${event.schema_version}`,
    yamlStringLine("occurred_at", event.occurred_at),
    yamlStringLine("confirmed_at", confirmedAt),
    yamlStringLine("process_instance", event.process_instance),
    yamlStringLine("idempotency_key", event.idempotency_key),
    yamlStringLine("process_code", event.process_code),
    yamlStringLine("actor", event.actor),
    yamlStringLine("access_role", event.access_role),
    yamlStringArray("supporting_access_roles", event.supporting_access_roles),
    yamlStringLine("outcome", event.outcome),
    yamlStringLine("repository", event.repository),
    yamlStringLine("artifact", event.artifact),
    yamlStringArray("correlation_ids", event.correlation_ids),
    yamlStringArray("evidence", event.evidence),
    yamlStringLine("reason", event.reason),
    yamlStringLine("description", event.description),
    "---",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Canonical journal-entry parser (SPEC-005 §external-contract)
// ---------------------------------------------------------------------------

/**
 * Parse and validate a SPEC-005 audit journal Markdown file for a specific
 * idempotency key.
 *
 * The function provides the shared canonical matching/validation logic used by
 * both `confirm_process_audit_delivery.mjs` (script) and the TypeScript
 * `confirmAuditEventInJournal` adapter method (whose implementation mirrors
 * this logic).
 *
 * Contract:
 *   - Returns `{ confirmedAt: string }` when the entry matches the key and
 *     has a valid canonical UTC `confirmed_at` timestamp.
 *   - Returns `null` when the file does not contain the idempotency key (not
 *     this entry; caller should try the next file).
 *   - Throws with a descriptive message when the file contains the key but is
 *     missing or has an invalid `confirmed_at` value.  Throws are NOT silently
 *     skipped — callers must propagate them immediately (fail-closed).
 *
 * @param {string} content  UTF-8 content of the journal file.
 * @param {string} filename  File name used in error messages.
 * @param {string} idempotencyKey  The idempotency key to search for.
 * @returns {{ confirmedAt: string } | null}
 */
export function parseJournalEntry(content, filename, idempotencyKey) {
  const marker = `idempotency_key: "${idempotencyKey}"`;
  if (!content.includes(marker)) {
    return null; // not this entry
  }

  // Entry matches.  Extract confirmed_at — fail-closed if absent or invalid.
  const match = content.match(/confirmed_at:\s*"([^"]+)"/);
  if (!match) {
    throw new Error(
      `audit journal entry for idempotency_key "${idempotencyKey}" in '${filename}' ` +
      `is missing the required 'confirmed_at' field — the entry may be incomplete or corrupt.`,
    );
  }
  const rawConfirmedAt = match[1];

  // Delegate to the shared canonical UTC validator which also enforces
  // the round-trip requirement (value must equal Date.toISOString()).
  const confirmedAt = validateCanonicalUtcTimestamp(rawConfirmedAt, "confirmed_at");

  return { confirmedAt };
}
