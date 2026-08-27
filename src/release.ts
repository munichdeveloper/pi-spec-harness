/**
 * Immutable harness revision used by every generated reusable-workflow caller.
 *
 * This commit contains the complete v0.3.0 release-candidate workflow set,
 * including the phase-invariant and installer-label fixes from issues #84 and
 * #58. Keeping one full SHA here prevents individual templates from drifting
 * to mutable branches, future tags, or older incomplete releases.
 */
export const HARNESS_VERSION = "0.3.0";
export const DEFAULT_HARNESS_WORKFLOW_REF = "686178aa8160c296b334e7b6b9e63f0b4e719ad1";
