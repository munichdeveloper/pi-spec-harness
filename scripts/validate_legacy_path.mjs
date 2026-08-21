/**
 * Shared repository-relative path validator for legacy documentation directories.
 *
 * Used by both the run-documentation-finalizer workflow (to validate each
 * JSON-array element before passing it as a CLI flag) and the harness CLI
 * (via the TypeScript path-validator module).
 *
 * Rejection rules:
 *   - Empty string
 *   - POSIX absolute paths (start with `/`)
 *   - Windows drive paths (e.g. `C:\...` or `C:/...`)
 *   - Windows UNC paths (start with `\\`)
 *   - Windows device paths (start with `\\.\` or `\\?\`)
 *   - True `..` traversal segments (any path component that is exactly `..`)
 *   - Dot-only paths (any path component that is exactly `.`)
 *   - Option-like paths (start with `-`)
 *   - NUL byte (0x00) or other control characters (0x01–0x1F, 0x7F)
 *
 * Allowed:
 *   - Relative paths with forward or backward slashes (normalized to `/`)
 *   - Spaces in path components
 *   - Double-dot within a name (e.g. `docs/v1..v2`)
 *   - Any printable characters not in the reject list above
 *
 * Usage (CLI):
 *   node scripts/validate_legacy_path.mjs "docs/runs/legacy"
 *   → exits 0 if valid, exits 1 with error on stderr if invalid.
 *
 * Usage (module):
 *   import { validateLegacyPath } from "./validate_legacy_path.mjs";
 *   validateLegacyPath("docs/runs/legacy"); // throws if invalid
 */

import { URL } from "node:url";

/**
 * Validate a single repository-relative legacy directory path.
 *
 * @param {string} rawPath  The path to validate.
 * @throws {Error}  If the path violates any constraint.
 */
export function validateLegacyPath(rawPath) {
  if (typeof rawPath !== "string") {
    throw new Error(`path must be a string, got ${typeof rawPath}.`);
  }

  // Empty
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

  // Option-like (starts with -)
  if (rawPath.startsWith("-")) {
    throw new Error(
      `legacy directory path must not start with '-' (option-like value rejected): '${rawPath}'.`,
    );
  }

  // Windows UNC / device paths: start with \\ or //
  // Check BEFORE POSIX absolute so //server/share is classified correctly.
  if (/^(\\\\|\/\/)/.test(rawPath)) {
    throw new Error(
      `legacy directory path must be relative (Windows UNC/device path rejected): '${rawPath}'.`,
    );
  }

  // Windows drive paths: "C:" at start (letter + colon), followed by / or \
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

  // Normalize to forward slashes for segment analysis
  const normalized = rawPath.replace(/\\/g, "/");

  // Split into segments and check each one
  const segments = normalized.split("/");
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    // Allow a single trailing slash (last segment is empty); reject internal empty segments.
    if (segment === "") {
      if (i === segments.length - 1) continue; // trailing slash is fine
      throw new Error(
        `legacy directory path must not contain internal double-slashes: '${rawPath}'.`,
      );
    }

    // True traversal: segment is exactly ".."
    if (segment === "..") {
      throw new Error(
        `legacy directory path must not contain '..' traversal segments: '${rawPath}'.`,
      );
    }

    // Dot-only segment: exactly "."
    if (segment === ".") {
      throw new Error(
        `legacy directory path must not contain '.' segments: '${rawPath}'.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

// When run directly (not imported as a module), validate the first argument.
if (process.argv[1] && new URL(process.argv[1], "file://").pathname ===
    new URL(import.meta.url).pathname) {
  const arg = process.argv[2];
  if (arg === undefined) {
    process.stderr.write(
      "Usage: node scripts/validate_legacy_path.mjs <path>\n",
    );
    process.exit(1);
  }
  try {
    validateLegacyPath(arg);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`::error::${err.message}\n`);
    process.exit(1);
  }
}
