import { createHash } from "node:crypto";

/**
 * Version of the capability test contract.
 * Bump this when the test contract (smoke steps, expected file content, etc.)
 * changes, so existing attestations are automatically invalidated.
 */
export const CAPABILITY_CONTRACT_VERSION = "1";

/**
 * Deterministic SHA-256 fingerprint for capability attestation (SPEC-010 TAC-01).
 *
 * Inputs:
 * - actionRef: the full pinned `uses:` reference string for the claude-code-action
 *   used by both Smoke and Bug Pipeline, e.g. `anthropics/claude-code-action@v1.0.94`
 *   (not just the isolated tag or 40-char commit SHA)
 * - permissionsAllow: the canonical `settings.permissions.allow` array passed
 *   to claude-code-action, sorted and JSON-serialised
 * - contractVersion: {@link CAPABILITY_CONTRACT_VERSION} — bump to invalidate
 *   all existing attestations after a contract change
 *
 * Excluded from the fingerprint (by design):
 * - Issue contents, branch names, secrets, run IDs, free-form text
 *
 * Returns a 64-char lowercase hex string.
 */
export function computeCapabilityFingerprint(options: {
  actionRef: string;
  permissionsAllow: string[];
  contractVersion?: string;
}): string {
  const { actionRef, permissionsAllow, contractVersion = CAPABILITY_CONTRACT_VERSION } = options;

  // Canonical serialisation: sorted allow list → compact JSON
  const canonicalPermissions = JSON.stringify([...permissionsAllow].sort());

  const input = [actionRef, canonicalPermissions, contractVersion].join("\n");
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Build the GitHub Actions cache key for a given fingerprint.
 *
 * TAC-02: only exact-key lookups are permitted; restore-keys / prefix
 * matching is explicitly excluded.
 */
export function capabilityCacheKey(fingerprint: string): string {
  return `harness-capability-attestation-${fingerprint}`;
}
