/**
 * Shared SPEC-005 journal entry parser — single source of truth for
 * `validateCanonicalUtcTimestamp` and `parseJournalEntry`.
 *
 * Imported by:
 *   - `src/github/gh.ts`  (TypeScript static import; resolved via journalParser.d.ts)
 *   - `scripts/process_audit_support.mjs`  (ESM; imports this .js file directly)
 *
 * Both call paths execute the exact same implementation so that validation
 * rules, error messages and behaviour are always in sync.
 *
 * SPEC-005 §external-contract / §security.
 */

/**
 * Validates that `value` is a canonical UTC ISO 8601 timestamp as produced
 * by `Date.toISOString()` (e.g. `"2026-08-18T22:09:10.000Z"`).
 *
 * @param {string} value     The raw string to validate.
 * @param {string} fieldName Field name used in error messages (e.g. `"occurred_at"`).
 * @returns {string} The canonical timestamp string (same as input when valid).
 */
export function validateCanonicalUtcTimestamp(value, fieldName) {
  if (typeof value !== "string") {
    throw new Error(
      `SPEC-005 validation failed: '${fieldName}' must be a string, got ${typeof value}.`,
    );
  }
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
 * Parses a SPEC-005 journal entry file and returns the confirmed_at timestamp
 * if the entry matches the given idempotency key.
 *
 * Fail-closed: any missing or non-canonical `confirmed_at` throws immediately.
 * Files that do not contain the idempotency key marker return `null`.
 *
 * @param {string} content        Raw file content of the journal entry.
 * @param {string} filename       File path/name used in error messages.
 * @param {string} idempotencyKey The idempotency key to search for.
 * @returns {{ confirmedAt: string } | null}
 */
export function parseJournalEntry(content, filename, idempotencyKey) {
  const marker = `idempotency_key: "${idempotencyKey}"`;
  if (!content.includes(marker)) {
    return null;
  }

  const match = content.match(/confirmed_at:\s*"([^"]+)"/);
  if (!match) {
    throw new Error(
      `audit journal entry for idempotency_key "${idempotencyKey}" in '${filename}' ` +
      `is missing the required 'confirmed_at' field — the entry may be incomplete or corrupt.`,
    );
  }
  const rawConfirmedAt = match[1];

  const confirmedAt = validateCanonicalUtcTimestamp(rawConfirmedAt, "confirmed_at");
  return { confirmedAt };
}
