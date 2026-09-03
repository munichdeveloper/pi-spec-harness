/**
 * Immutable harness revision used by every generated reusable-workflow caller.
 *
 * This commit contains the complete v0.4.3 workflow set introduced by the
 * dedicated audit-writer implementation. Release verification proves that
 * every reusable workflow is byte-identical
 * between this immutable pin and the release candidate. Keeping one
 * full SHA here prevents individual templates from drifting to mutable branches,
 * future tags, or older incomplete releases.
 */
export const HARNESS_VERSION = "0.4.3";
export const DEFAULT_HARNESS_WORKFLOW_REF = "402289e68f558a76ab62078b11f90a5e3d947416";
