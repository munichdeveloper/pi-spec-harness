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
 * Section detection: a section is considered present when its name appears
 * anywhere in the document text (case-insensitive).  This is intentionally
 * lenient to handle heading levels and minor formatting variation.
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
  const lower = content.toLowerCase();

  const missingSections = requiredSections.filter(
    (section) => !lower.includes(section.toLowerCase()),
  );

  const traceable = lower.includes(requirementId.toLowerCase());

  return {
    valid: missingSections.length === 0 && traceable,
    missingSections,
    traceable,
  };
}
