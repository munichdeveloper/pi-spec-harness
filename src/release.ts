/**
 * Immutable harness revision used by every generated reusable-workflow caller.
 *
 * This commit contains the workflow set extended by the SPEC-017 installation
 * preflight and zero-knowledge intake. Release verification proves that
 * every reusable workflow is byte-identical
 * between this immutable pin and the release candidate. Keeping one
 * full SHA here prevents individual templates from drifting to mutable branches,
 * future tags, or older incomplete releases.
 */
export const HARNESS_VERSION = "0.4.3";
export const DEFAULT_HARNESS_WORKFLOW_REF = "8d57f7f8c19a526af320a0d8a1b8cce6a7cd578f";

/**
 * Explicit two-phase bootstrap for reusable-workflow changes.
 *
 * A changed workflow may pass release verification only when its candidate
 * bytes match the declared SHA-256 exactly. The follow-up pin PR must advance
 * DEFAULT_HARNESS_WORKFLOW_REF to the merged commit and remove the declaration.
 * An empty map is the normal/released state.
 */
export const PENDING_REUSABLE_WORKFLOW_SHA256: Readonly<Record<string, string>> = Object.freeze({
  ".github/workflows/label-approval-bundling.yml": "5c28cfd1d87a0aa812a08aa493c4c1977dbd68e12f040c6770c91739265c7580",
  ".github/workflows/requirement-to-spec.yml": "52ac79e6019fb954ac2182f6376422555918fa4fcf107353f4cfb901cd8253ee",
});
