/**
 * Path validation helpers for run documentation writes.
 * SPEC-012, decision 5 / TAC-10.
 *
 * Rules enforced:
 * - Paths must be relative (no leading slash, no drive letter).
 * - Paths must not contain `..` components.
 * - Paths must not contain NUL or other control characters.
 * - Resolved paths must fall within the configured allowlist directories.
 */

/** Allowlist of top-level directories the writer is permitted to touch. */
const ALLOWLISTED_PREFIXES: ReadonlyArray<string> = [
  "docs/",
  ".github/",
];

/**
 * Validate a single relative path intended for a documentation write.
 *
 * @throws {Error} with a descriptive message when the path is rejected.
 */
export function validateDocumentationPath(
  relativePath: string,
  allowlistedPrefixes: ReadonlyArray<string> = ALLOWLISTED_PREFIXES,
): void {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("documentation path must be a non-empty string");
  }

  // Reject absolute paths (Unix and Windows-style).
  if (relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) {
    throw new Error(`documentation path must be relative, got: ${relativePath}`);
  }

  // Reject control characters (including NUL).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(relativePath)) {
    throw new Error(`documentation path contains illegal control character: ${relativePath}`);
  }

  // Reject path-traversal components.
  const normalized = normalizePath(relativePath);
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) {
    throw new Error(`documentation path contains traversal component (..): ${relativePath}`);
  }

  // Reject paths that escape the repository root after normalization.
  if (normalized.startsWith("../")) {
    throw new Error(`documentation path escapes repository root: ${relativePath}`);
  }

  // Enforce allowlist.
  const allowed = allowlistedPrefixes.some(
    (prefix) => normalized === prefix.replace(/\/$/, "") || normalized.startsWith(prefix),
  );
  if (!allowed) {
    throw new Error(
      `documentation path '${relativePath}' is outside the allowlisted directories: ${allowlistedPrefixes.join(", ")}`,
    );
  }
}

/**
 * Normalize a relative path: collapse duplicate slashes, remove trailing
 * slashes, remove leading `./`. Does NOT resolve symlinks.
 */
export function normalizePath(p: string): string {
  return p
    .replace(/\\/g, "/")           // normalize Windows separators
    .replace(/\/+/g, "/")          // collapse duplicate slashes
    .replace(/^\.\//, "")          // remove leading ./
    .replace(/\/$/, "");           // remove trailing slash
}

/**
 * Check that a set of staged paths contains exactly the expected three
 * documentation paths and nothing else. SPEC-012, decision 7 / TAC-10.
 *
 * @throws {Error} if any unexpected path appears or an expected path is missing.
 */
export function validateStagedPaths(
  stagedPaths: string[],
  expectedPaths: [snapshotPath: string, indexPath: string, obsidianBasePath: string],
): void {
  const expected = new Set(expectedPaths.map(normalizePath));
  const staged = stagedPaths.map(normalizePath);

  const unexpected = staged.filter((p) => !expected.has(p));
  if (unexpected.length > 0) {
    throw new Error(
      `writer aborted: unexpected staged path(s): ${unexpected.join(", ")}`,
    );
  }
  const missing = [...expected].filter((p) => !staged.includes(p));
  if (missing.length > 0) {
    throw new Error(
      `writer aborted: expected staged path(s) missing: ${missing.join(", ")}`,
    );
  }
}
