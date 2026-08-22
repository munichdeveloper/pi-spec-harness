/**
 * Configuration for run documentation generation.
 * SPEC-012, decision 5.
 */
export interface RunDocumentationConfig {
  /** Directory for generated run snapshots. Default: "docs/runs/generated" */
  generatedDirectory: string;
  /** Path of the run index document. Default: "docs/runs/RUN-INDEX.md" */
  indexPath: string;
  /** Path of the Obsidian base document. Default: "docs/runs/Runs.base" */
  obsidianBasePath: string;
  /**
   * Legacy directories to scan for existing (non-generated) run documents.
   * Default: ["docs/runs"]
   */
  legacyDirectories: string[];
}

export const DEFAULT_RUN_DOCUMENTATION_CONFIG: RunDocumentationConfig = {
  generatedDirectory: "docs/runs/generated",
  indexPath: "docs/runs/RUN-INDEX.md",
  obsidianBasePath: "docs/runs/Runs.base",
  legacyDirectories: ["docs/runs"],
};
