/**
 * SPEC-005 process audit delivery confirmation.
 *
 * Scans the journal directory for a file containing the given idempotency_key
 * and prints the `confirmed_at` timestamp found in its frontmatter.  Exits
 * with code 0 if found, 1 if not found after scanning all files.
 *
 * Usage (from CLI or workflow step):
 *   JOURNAL_DIR=docs/process-audit/journal \
 *   IDEMPOTENCY_KEY=my-key \
 *   node scripts/confirm_process_audit_delivery.mjs
 *
 * Outputs the `confirmed_at` timestamp to stdout when found.
 * No field values are interpolated into shell arguments.
 *
 * Fail-closed: any file-read error or malformed/non-UTC confirmed_at exits 1
 * immediately. Files that do not match the idempotency key marker are skipped.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJournalEntry } from "./process_audit_support.mjs";

const JOURNAL_DIR = process.env["JOURNAL_DIR"] ?? "docs/process-audit/journal";
const IDEMPOTENCY_KEY = process.env["IDEMPOTENCY_KEY"] ?? "";

if (!IDEMPOTENCY_KEY) {
  console.error("::error::IDEMPOTENCY_KEY environment variable is required.");
  process.exit(1);
}

if (!existsSync(JOURNAL_DIR)) {
  console.error(
    `::error::Journal directory '${JOURNAL_DIR}' does not exist. ` +
    `Ensure the process-audit-automation workflow is installed in this repository.`,
  );
  process.exit(1);
}

const marker = `idempotency_key: "${IDEMPOTENCY_KEY}"`;
let files;
try {
  files = readdirSync(JOURNAL_DIR).filter((f) => f.endsWith(".md"));
} catch (err) {
  console.error(`::error::Cannot read journal directory '${JOURNAL_DIR}': ${err.message}`);
  process.exit(1);
}

for (const name of files) {
  // Fail closed: any read error is fatal (not silently skipped).
  let content;
  try {
    content = readFileSync(join(JOURNAL_DIR, name), "utf8");
  } catch (err) {
    console.error(
      `::error::Cannot read journal file '${JOURNAL_DIR}/${name}': ${err.message} — aborting confirmation.`,
    );
    process.exit(1);
  }

  if (content.includes(marker)) {
    // Delegate to the shared canonical parser.  It validates idempotency_key
    // presence, confirmed_at existence, and the canonical UTC round-trip.
    // Any validation error propagates immediately (fail-closed).
    let result;
    try {
      result = parseJournalEntry(content, `${JOURNAL_DIR}/${name}`, IDEMPOTENCY_KEY);
    } catch (parseErr) {
      console.error(`::error::${parseErr.message}`);
      process.exit(1);
    }
    if (result) {
      process.stdout.write(result.confirmedAt + "\n");
      process.exit(0);
    }
  }
}

console.error(
  `::error::Audit event with idempotency_key "${IDEMPOTENCY_KEY}" not found in '${JOURNAL_DIR}'.`,
);
process.exit(1);
