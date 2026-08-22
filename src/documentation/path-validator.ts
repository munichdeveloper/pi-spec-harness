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

  // Enforce allowlist: path must be *inside* an allowlisted directory, i.e.
  // it must start with the prefix (which always ends in "/"). Bare directory
  // names like "docs" or ".github" are intentionally rejected.
  const allowed = allowlistedPrefixes.some((prefix) => {
    const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return normalized.startsWith(normalizedPrefix);
  });
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

  // Enforce uniqueness: reject duplicate staged paths.
  if (staged.length !== new Set(staged).size) {
    const seen = new Set<string>();
    const duplicates = staged.filter((p) => {
      if (seen.has(p)) return true;
      seen.add(p);
      return false;
    });
    throw new Error(
      `writer aborted: duplicate staged path(s): ${[...new Set(duplicates)].join(", ")}`,
    );
  }

  // Enforce exact content match (also catches cardinality differences).
  const unexpected = staged.filter((p) => !expected.has(p));
  const missing = [...expected].filter((p) => !staged.includes(p));
  if (unexpected.length > 0 && missing.length > 0) {
    throw new Error(
      `writer aborted: unexpected staged path(s): ${unexpected.join(", ")}; expected staged path(s) missing: ${missing.join(", ")}`,
    );
  }
  if (unexpected.length > 0) {
    throw new Error(
      `writer aborted: unexpected staged path(s): ${unexpected.join(", ")}`,
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `writer aborted: expected staged path(s) missing: ${missing.join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// SPEC-012 TAC-14: Content safety validation (PII, secrets, evidence URLs)
// ---------------------------------------------------------------------------

/** Token/secret patterns that must never appear in rendered documentation. */
const CONTENT_SECRET_PATTERNS: RegExp[] = [
  /gh[oprsu]_[A-Za-z0-9]{20,}/,        // GitHub tokens
  /sk-[A-Za-z0-9]{20,}/,               // OpenAI/Anthropic-style secret keys
  /xox[baprs]-[A-Za-z0-9-]{10,}/,      // Slack tokens
  /AKIA[0-9A-Z]{16}/,                   // AWS access key id
];

/** PII patterns that must not appear in rendered documentation. */
const PII_PATTERNS: RegExp[] = [
  // Email addresses
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  // Phone numbers in common formats (+1 555-555-5555, (555) 555-5555 etc.)
  // Use a non-word lookbehind instead of \b so that a leading "+" is also
  // matched when the number starts at the beginning of a string or after
  // whitespace (e.g. "+49 123 456 7890"). A plain \b before an optional "+"
  // would not match at a position where the next character is "+" (a non-word
  // character), allowing international numbers to evade detection.
  /(?<!\w)(?:\+\d{1,3}[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/,
];

/**
 * Evidence URL pattern: a URL with a query string (`?...`) or fragment (`#...`)
 * is not allowed in documentation (policy: evidence URLs must be clean).
 */
const EVIDENCE_URL_WITH_QUERY_OR_FRAGMENT = /https?:\/\/[^\s"']+[?#][^\s"']*/;

/**
 * Validate the rendered snapshot content for PII, secrets, and policy
 * violations. Throws a descriptive error if any pattern is matched.
 * SPEC-012 TAC-14.
 */
export function validateSnapshotContent(content: string): void {
  for (const pattern of CONTENT_SECRET_PATTERNS) {
    if (pattern.test(content)) {
      throw new Error(
        `snapshot content rejected: matches secret/token pattern ${pattern}`,
      );
    }
  }
  for (const pattern of PII_PATTERNS) {
    if (pattern.test(content)) {
      throw new Error(
        `snapshot content rejected: matches PII pattern ${pattern}`,
      );
    }
  }
  if (EVIDENCE_URL_WITH_QUERY_OR_FRAGMENT.test(content)) {
    throw new Error(
      "snapshot content rejected: contains evidence URL with query string or fragment",
    );
  }
}

// ---------------------------------------------------------------------------
// Legacy directory path validation (SPEC-012, shared with validate_legacy_path.mjs)
// ---------------------------------------------------------------------------

/**
 * Validate a repository-relative legacy directory path supplied via
 * `--legacy-directory`.  Mirrors the validation rules from
 * `scripts/validate_legacy_path.mjs`; keep both in sync.
 *
 * Rejection rules:
 *   - Empty string
 *   - POSIX absolute paths (start with `/`)
 *   - Windows drive paths (`C:\...` or `C:/...`)
 *   - Windows UNC / device paths (start with `\\` or `//`)
 *   - True `..` traversal segments (any component that is exactly `..`)
 *   - Dot-only segments (any component that is exactly `.`)
 *   - Option-like paths (start with `-`)
 *   - NUL byte (0x00) or other control characters (0x01–0x1F, 0x7F)
 *
 * Allowed:
 *   - Relative paths with forward or backward slashes (normalized to `/`)
 *   - Spaces in path components
 *   - Double-dot within a name (e.g. `docs/v1..v2`)
 *
 * @throws {Error}  If the path violates any constraint.
 */
export function validateLegacyDirectoryPath(rawPath: string): void {
  if (typeof rawPath !== "string") {
    throw new Error(`legacy directory path must be a string, got ${typeof rawPath}.`);
  }
  if (rawPath.length === 0) {
    throw new Error("legacy directory path must not be empty.");
  }

  // NUL and control characters (0x00–0x1F, 0x7F DEL)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(rawPath)) {
    throw new Error(
      `legacy directory path must not contain NUL or control characters: '${rawPath}'.`,
    );
  }

  // Option-like
  if (rawPath.startsWith("-")) {
    throw new Error(
      `legacy directory path must not start with '-' (option-like value rejected): '${rawPath}'.`,
    );
  }

  // Windows UNC / device paths — check BEFORE POSIX absolute
  if (/^(\\\\|\/{2})/.test(rawPath)) {
    throw new Error(
      `legacy directory path must be relative (Windows UNC/device path rejected): '${rawPath}'.`,
    );
  }

  // Windows drive paths
  if (/^[A-Za-z]:[/\\]/.test(rawPath)) {
    throw new Error(
      `legacy directory path must be relative (Windows drive path rejected): '${rawPath}'.`,
    );
  }

  // POSIX absolute
  if (rawPath.startsWith("/")) {
    throw new Error(
      `legacy directory path must be relative (POSIX absolute path rejected): '${rawPath}'.`,
    );
  }

  // Segment-level checks
  const normalized = rawPath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "") {
      if (i === segments.length - 1) continue; // trailing slash is acceptable
      throw new Error(
        `legacy directory path must not contain internal double-slashes: '${rawPath}'.`,
      );
    }
    if (segment === "..") {
      throw new Error(
        `legacy directory path must not contain '..' traversal segments: '${rawPath}'.`,
      );
    }
    if (segment === ".") {
      throw new Error(
        `legacy directory path must not contain '.' segments: '${rawPath}'.`,
      );
    }
  }
}
