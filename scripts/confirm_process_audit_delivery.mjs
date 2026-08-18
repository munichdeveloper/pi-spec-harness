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
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
const files = readdirSync(JOURNAL_DIR).filter((f) => f.endsWith(".md"));

for (const name of files) {
  const content = readFileSync(join(JOURNAL_DIR, name), "utf8");
  if (content.includes(marker)) {
    const match = content.match(/confirmed_at:\s*"([^"]+)"/);
    if (!match) {
      console.error(
        `::error::Audit journal entry for idempotency_key "${IDEMPOTENCY_KEY}" in '${JOURNAL_DIR}/${name}' ` +
        `is missing the required 'confirmed_at' field — the entry may be incomplete or corrupt.`,
      );
      process.exit(1);
    }
    process.stdout.write(match[1] + "\n");
    process.exit(0);
  }
}

console.error(
  `::error::Audit event with idempotency_key "${IDEMPOTENCY_KEY}" not found in '${JOURNAL_DIR}'.`,
);
process.exit(1);
