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
export const DEFAULT_HARNESS_WORKFLOW_REF = "a14f1702f4f77fd2eadbc351b1a228e0982ebe9f";

/**
 * Explicit two-phase bootstrap for reusable-workflow changes.
 *
 * A changed workflow may pass release verification only when its candidate
 * bytes match the declared SHA-256 exactly. The follow-up pin PR must advance
 * DEFAULT_HARNESS_WORKFLOW_REF to the merged commit and remove the declaration.
 * An empty map is the normal/released state.
 */
export const PENDING_REUSABLE_WORKFLOW_SHA256: Readonly<Record<string, string>> = Object.freeze({
  ".github/workflows/requirement-to-spec.yml": "02715d5140073e06c3d5df2e15f7b94ead154396237907ebe35c742ce40e5879",
});
