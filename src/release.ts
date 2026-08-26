/**
 * Immutable harness revision used by every generated reusable-workflow caller.
 *
 * This commit contains the complete v0.3.0 release-candidate workflow set,
 * including the phase-invariant and installer-label fixes from issues #84 and
 * #58. Keeping one full SHA here prevents individual templates from drifting
 * to mutable branches, future tags, or older incomplete releases.
 */
export const HARNESS_VERSION = "0.3.0";
export const DEFAULT_HARNESS_WORKFLOW_REF = "df2561910e27e8a849d89b475b7a6db54252d45b";
