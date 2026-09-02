/**
 * Immutable harness revision used by every generated reusable-workflow caller.
 *
 * This commit contains the complete, hosted-verified v0.4.2 workflow set.
 * Release verification proves that every reusable workflow is byte-identical
 * between this immutable pin and the release candidate. Keeping one
 * full SHA here prevents individual templates from drifting to mutable branches,
 * future tags, or older incomplete releases.
 */
export const HARNESS_VERSION = "0.4.2";
export const DEFAULT_HARNESS_WORKFLOW_REF = "fb7045becaf14018e3d3ae3a03e9430027043768";
