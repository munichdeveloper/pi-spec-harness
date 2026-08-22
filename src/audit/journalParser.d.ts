/**
 * TypeScript declarations for the shared SPEC-005 journal entry parser.
 *
 * This module is the single source of truth for `validateCanonicalUtcTimestamp`
 * and `parseJournalEntry`.  See `journalParser.js` for the implementation.
 */

/**
 * Validates that `value` is a canonical UTC ISO 8601 timestamp as produced
 * by `Date.toISOString()` (e.g. `"2026-08-18T22:09:10.000Z"`).
 *
 * @throws {Error} with a descriptive message when validation fails.
 */
export declare function validateCanonicalUtcTimestamp(value: string, fieldName: string): string;

/**
 * Parses a SPEC-005 journal entry file and returns the confirmed_at timestamp
 * if the entry matches the given idempotency key.
 *
 * @returns `{ confirmedAt }` when the entry matches and is valid; `null` when
 *          the entry does not contain the marker.
 * @throws {Error} when the entry matches but `confirmed_at` is absent or invalid.
 */
export declare function parseJournalEntry(
  content: string,
  filename: string,
  idempotencyKey: string,
): { confirmedAt: string } | null;
