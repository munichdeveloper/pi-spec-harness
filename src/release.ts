/**
 * Immutable harness revision used by every generated reusable-workflow caller.
 *
 * This commit contains the complete, hosted-verified v0.4.0 workflow set,
 * including SPEC-016 readiness, recovery and evidence disposition. Keeping one
 * full SHA here prevents individual templates from drifting to mutable branches,
 * future tags, or older incomplete releases.
 */
export const HARNESS_VERSION = "0.4.0";
export const DEFAULT_HARNESS_WORKFLOW_REF = "5937140980486653398dd379dd87c86252403ec6";
