/**
 * Pure spec content validation.
 * SPEC-014 TAC-05: validates required sections and REQ traceability before
 * a generated spec PR is accepted or marked ready.
 */

export interface SpecValidationResult {
  /** True when all required sections are present AND traceability is satisfied. */
  valid: boolean;
  /** Required section names absent from the content (empty when all present). */
  missingSections: string[];
  /** True when the requirementId literal appears in the content. */
  traceable: boolean;
}

/**
 * Validate a generated spec document for required sections and REQ traceability.
 *
 * Section detection requires a Markdown ATX heading (levels 1–6). This keeps
 * prose, checklists, prompts, and code examples from satisfying a mandatory
 * section accidentally while still accepting different heading levels.
 *
 * Traceability detection: the exact `requirementId` string must appear
 * literally in the document (case-insensitive).
 *
 * @param content        Raw Markdown content of the generated spec file.
 * @param requiredSections Array of section names that must be present.
 * @param requirementId  REQ identifier (e.g. "REQ-014") that must appear.
 */
export function validateSpecContent(
  content: string,
  requiredSections: string[],
  requirementId: string,
): SpecValidationResult {
  const missingSections = requiredSections.filter(
    (section) => {
      const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return !new RegExp(`^#{1,6}\\s+${escaped}\\s*:?[ \\t]*$`, "im").test(content);
    },
  );

  const traceable = content.toLowerCase().includes(requirementId.toLowerCase());

  return {
    valid: missingSections.length === 0 && traceable,
    missingSections,
    traceable,
  };
}
