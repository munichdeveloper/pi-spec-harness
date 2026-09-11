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
export const DEFAULT_HARNESS_WORKFLOW_REF = "0a85b0847a5f0a39e120b0c6acc4f85ed2989015";

/**
 * Explicit two-phase bootstrap for reusable-workflow changes.
 *
 * A changed workflow may pass release verification only when its candidate
 * bytes match the declared SHA-256 exactly. The follow-up pin PR must advance
 * DEFAULT_HARNESS_WORKFLOW_REF to the merged commit and remove the declaration.
 * An empty map is the normal/released state.
 */
export const PENDING_REUSABLE_WORKFLOW_SHA256: Readonly<Record<string, string>> = Object.freeze({
  ".github/workflows/label-approval-bundling.yml": "c4878e172279d0beae1fe336223a4fe957a23caf3b7a13b65817075a1fbf6fc8",
});
