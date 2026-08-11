export type WorkflowInstallDecision = "create" | "noop" | "update-managed" | "conflict";

/**
 * Generic version of the bug-specific `decideBugWorkflowInstall()`. Given
 * the current file content (if any), the expected rendered content, and the
 * managed-marker string for the template in question, decide what write
 * action (if any) is needed. Used uniformly for every catalog entry so a
 * new template only has to supply a marker and a render function, not its
 * own decision logic (SPEC-006 TAC-05).
 */
export function decideWorkflowInstall(
  existingContent: string | undefined,
  expectedContent: string,
  marker: string,
): WorkflowInstallDecision {
  if (existingContent === undefined) return "create";
  if (existingContent === expectedContent) return "noop";
  if (existingContent.includes(marker)) return "update-managed";
  return "conflict";
}
