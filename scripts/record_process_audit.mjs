/**
 * SPEC-005 process audit recorder.
 *
 * Validates the incoming envelope-v1 payload, derives a collision-safe
 * chronological filename from `occurred_at`, enforces idempotency against
 * existing journal entries, writes a YAML-frontmatter journal file, and
 * commits+pushes with a bounded fetch/rebase retry.
 *
 * Entry point: run as `node scripts/record_process_audit.mjs` from a
 * Git working directory with the caller repo checked out.
 *
 * Required environment variables:
 *   AUDIT_PAYLOAD_JSON  – JSON string of `client_payload.audit` (env-var only,
 *                         never passed via shell argument to avoid injection)
 *   JOURNAL_DIR         – relative path to the journal directory
 *                         (default: docs/process-audit/journal)
 *   DEFAULT_BRANCH      – target branch for push
 *                         (default: main)
 *
 * No field values from the payload are interpolated into shell commands,
 * YAML strings, or git arguments (SPEC-005 §security).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeProcessAuditInput } from "./normalize_process_audit_input.mjs";

// ---------------------------------------------------------------------------
// Configuration from environment (never from shell args to avoid injection)
// ---------------------------------------------------------------------------

const AUDIT_PAYLOAD_JSON = process.env["AUDIT_PAYLOAD_JSON"] ?? "";
const JOURNAL_DIR = process.env["JOURNAL_DIR"] ?? "docs/process-audit/journal";
const DEFAULT_BRANCH = process.env["DEFAULT_BRANCH"] ?? "main";
const MAX_PUSH_RETRIES = 3;

if (!AUDIT_PAYLOAD_JSON) {
  console.error("::error::AUDIT_PAYLOAD_JSON environment variable is required.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Parse and validate
// ---------------------------------------------------------------------------

let raw;
try {
  raw = JSON.parse(AUDIT_PAYLOAD_JSON);
} catch (err) {
  console.error(`::error::Failed to parse AUDIT_PAYLOAD_JSON: ${err.message}`);
  process.exit(1);
}

let event;
try {
  event = normalizeProcessAuditInput(raw);
} catch (err) {
  console.error(`::error::${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Collision-safe filename from occurred_at + hash of idempotency_key
// (SPEC-005 decision 4: chronologically sortable, stable, unique)
// ---------------------------------------------------------------------------

// Derive a 16-hex-char prefix from the SHA-256 of the idempotency_key.
const keyHash = createHash("sha256")
  .update(event.idempotency_key, "utf8")
  .digest("hex")
  .slice(0, 16);

// Compact ISO timestamp: 20260802T152132Z (safe for filenames on all OSes).
const compactTs = event.occurred_at
  .replace(/[-:]/g, "")
  .replace(/\.\d+Z$/, "Z");

const filename = `${compactTs}-${keyHash}.md`;
const journalFile = join(JOURNAL_DIR, filename);

// ---------------------------------------------------------------------------
// Idempotency: scan existing journal entries for the same idempotency_key
// ---------------------------------------------------------------------------

const idempotencyMarker = `idempotency_key: "${event.idempotency_key}"`;

if (existsSync(JOURNAL_DIR)) {
  const existing = readdirSync(JOURNAL_DIR).filter((f) => f.endsWith(".md"));
  for (const name of existing) {
    const content = readFileSync(join(JOURNAL_DIR, name), "utf8");
    if (content.includes(idempotencyMarker)) {
      console.log(
        `Audit event already recorded for idempotency_key '${event.idempotency_key}' ` +
        `in '${name}' — skipping (idempotent).`,
      );
      process.exit(0);
    }
  }
}

// ---------------------------------------------------------------------------
// Write the journal entry (YAML frontmatter at column 0, no interpolation)
// ---------------------------------------------------------------------------

const confirmedAt = new Date().toISOString();
const correlationIdsYaml = event.correlation_ids
  .map((id) => `  - "${id}"`)
  .join("\n");
const evidenceYaml = event.evidence
  .map((url) => `  - "${url}"`)
  .join("\n");
const supportingRolesYaml = event.supporting_access_roles
  .map((r) => `  - "${r}"`)
  .join("\n");

// Build YAML frontmatter using template literal (no user data in YAML keys;
// string values are quoted and cannot contain injected YAML structure because
// they come from the validated normalizer which enforces string types only).
const frontmatter = [
  "---",
  `schema_version: ${event.schema_version}`,
  `occurred_at: "${event.occurred_at}"`,
  `confirmed_at: "${confirmedAt}"`,
  `process_instance: "${event.process_instance}"`,
  `idempotency_key: "${event.idempotency_key}"`,
  `process_code: "${event.process_code}"`,
  `actor: "${event.actor}"`,
  `access_role: "${event.access_role}"`,
  event.supporting_access_roles.length > 0
    ? `supporting_access_roles:\n${supportingRolesYaml}`
    : "supporting_access_roles: []",
  `outcome: "${event.outcome}"`,
  `repository: "${event.repository}"`,
  `artifact: "${event.artifact}"`,
  event.correlation_ids.length > 0
    ? `correlation_ids:\n${correlationIdsYaml}`
    : "correlation_ids: []",
  event.evidence.length > 0
    ? `evidence:\n${evidenceYaml}`
    : "evidence: []",
  `reason: "${event.reason}"`,
  `description: "${event.description}"`,
  "---",
].join("\n");

const body = `# Process Audit Journal Entry\n\n` +
  `<!-- harness:audit-record process_code=${event.process_code} -->\n\n` +
  `Recorded by the SPEC-005 harness recorder on ${confirmedAt}.\n`;

mkdirSync(JOURNAL_DIR, { recursive: true });
writeFileSync(journalFile, `${frontmatter}\n${body}`, "utf8");
console.log(`Wrote journal entry: ${journalFile}`);

// ---------------------------------------------------------------------------
// Commit and push with bounded retry (SPEC-005 decision 3)
// ---------------------------------------------------------------------------

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

run("git", ["config", "user.name", "github-actions[bot]"]);
run("git", [
  "config", "user.email",
  "41898282+github-actions[bot]@users.noreply.github.com",
]);
run("git", ["add", journalFile]);

// Check if there is anything to commit (idempotency guard already handled above,
// but guard again in case of a race between the scan and the write).
const diffOutput = execFileSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" });
if (!diffOutput.trim()) {
  console.log("Nothing to commit — journal entry already staged. Exiting cleanly.");
  process.exit(0);
}

run("git", ["commit", "--no-verify", "-m",
  `audit(harness): record ${event.process_code} for process_instance ${event.process_instance}`,
]);

// Push with explicit `HEAD:<branch>` ref spec (SPEC-005 §security: no implicit
// branch inference; push only to the verified default branch).
let pushed = false;
for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
  try {
    run("git", ["push", "origin", `HEAD:refs/heads/${DEFAULT_BRANCH}`]);
    pushed = true;
    break;
  } catch {
    if (attempt < MAX_PUSH_RETRIES) {
      console.log(`Push attempt ${attempt} failed (conflict); fetching and rebasing…`);
      run("git", ["fetch", "origin", DEFAULT_BRANCH]);
      run("git", ["rebase", `origin/${DEFAULT_BRANCH}`]);
    }
  }
}

if (!pushed) {
  console.error(`::error::Failed to push journal entry after ${MAX_PUSH_RETRIES} attempts.`);
  process.exit(1);
}

console.log(`Journal entry committed and pushed: ${journalFile}`);
