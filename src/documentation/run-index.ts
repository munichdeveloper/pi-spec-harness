/**
 * Deterministic run-index and Obsidian-base generators.
 * SPEC-012, decision 6 / TAC-09.
 *
 * Rules:
 * - Reads only validated frontmatter from snapshot files.
 * - Sorted descending by `completed_at` (alias `delivery_merged_at` /
 *   `updated_at`), ties broken by `qualified_run_id` then file path.
 * - Distinguishes `generated`, `legacy`, and `legacy-reconstructed` entries.
 * - No LLM or external SaaS calls. TAC-19.
 */

export type RunDocumentClassification = "generated" | "legacy" | "legacy-reconstructed";

/**
 * A validated entry parsed from a run-snapshot frontmatter block.
 */
export interface RunIndexEntry {
  /** Relative file path within the repository. */
  filePath: string;
  runId: string;
  qualifiedRunId: string;
  repository: string;
  spec: string;
  trackingIssue: number | null;
  trackingIssueUrl: string | null;
  phase: string;
  deliveryMergedAt: string | null;
  updatedAt: string | null;
  classification: RunDocumentClassification;
}

/**
 * Parse a minimal YAML frontmatter block (lines between `---` delimiters).
 * Only extracts string and numeric scalar fields used by the index.
 * Returns null if the frontmatter is missing or malformed.
 */
export function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const block = match[1];
  const result: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
    if (!m) continue;
    const key = m[1];
    const raw = m[2].trim().replace(/^"(.*)"$/, "$1");
    // Coerce numeric strings
    if (/^\d+$/.test(raw)) {
      result[key] = parseInt(raw, 10);
    } else if (raw === "true" || raw === "false") {
      result[key] = raw === "true";
    } else if (raw === "null") {
      result[key] = null;
    } else {
      result[key] = raw;
    }
  }
  return result;
}

/** Extract a string value or return null. */
function str(fm: Record<string, unknown>, key: string): string | null {
  const v = fm[key];
  return typeof v === "string" && v !== "null" ? v : null;
}

/** Extract a numeric value or return null. */
function num(fm: Record<string, unknown>, key: string): number | null {
  const v = fm[key];
  return typeof v === "number" ? v : null;
}

/**
 * Determine the classification of a run document from its frontmatter.
 * SPEC-012, decision 6.
 */
export function classifyRunDocument(
  fm: Record<string, unknown>,
  filePath: string,
): RunDocumentClassification {
  const generated = fm["generated"];
  const legacy = fm["legacy"];
  if (generated === true && legacy !== true) return "generated";
  // A file in a `reconstructed` subdirectory is legacy-reconstructed.
  if (filePath.includes("/reconstructed/")) return "legacy-reconstructed";
  return "legacy";
}

/**
 * Build a RunIndexEntry from a file path and its raw content.
 * Returns null when the file cannot be parsed as a valid run document.
 */
export function parseRunIndexEntry(filePath: string, content: string): RunIndexEntry | null {
  const fm = parseFrontmatter(content);
  if (!fm) return null;

  const runId = str(fm, "run_id");
  if (!runId) return null;

  const qualifiedRunId = str(fm, "qualified_run_id") ?? `${str(fm, "repository") ?? "unknown"}#${runId}`;
  const repository = str(fm, "repository") ?? "unknown";
  const spec = str(fm, "spec") ?? "unknown";
  const trackingIssue = num(fm, "tracking_issue");
  const trackingIssueUrl = str(fm, "tracking_issue_url");
  const phase = str(fm, "phase") ?? "unknown";
  const deliveryMergedAt = str(fm, "delivery_merged_at");
  const updatedAt = str(fm, "updated_at");
  const classification = classifyRunDocument(fm, filePath);

  return {
    filePath,
    runId,
    qualifiedRunId,
    repository,
    spec,
    trackingIssue,
    trackingIssueUrl,
    phase,
    deliveryMergedAt,
    updatedAt,
    classification,
  };
}

/**
 * Sort entries deterministically descending by completion time.
 * Primary: `deliveryMergedAt` or `updatedAt`, descending.
 * Tiebreaker 1: `qualifiedRunId`, ascending (lexicographic).
 * Tiebreaker 2: `filePath`, ascending.
 * SPEC-012, decision 6 / TAC-09.
 */
export function sortRunIndexEntries(entries: RunIndexEntry[]): RunIndexEntry[] {
  return [...entries].sort((a, b) => {
    const aTime = a.deliveryMergedAt ?? a.updatedAt ?? "";
    const bTime = b.deliveryMergedAt ?? b.updatedAt ?? "";
    const timeCmp = bTime.localeCompare(aTime);
    if (timeCmp !== 0) return timeCmp;
    const idCmp = a.qualifiedRunId.localeCompare(b.qualifiedRunId);
    if (idCmp !== 0) return idCmp;
    return a.filePath.localeCompare(b.filePath);
  });
}

/**
 * Render the `RUN-INDEX.md` file from sorted run index entries.
 * SPEC-012, decision 6 / TAC-09.
 */
export function generateRunIndex(entries: RunIndexEntry[], generatedAt: string): string {
  const sorted = sortRunIndexEntries(entries);

  const rows = sorted.map((e) => {
    const ti = e.trackingIssue !== null
      ? e.trackingIssueUrl
        ? `[#${e.trackingIssue}](${e.trackingIssueUrl})`
        : `#${e.trackingIssue}`
      : "null";
    const completed = e.deliveryMergedAt ?? e.updatedAt ?? "null";
    return `| [${e.runId}](${e.filePath}) | ${e.repository} | ${e.phase} | ${e.spec} | ${ti} | ${completed} | ${e.classification} |`;
  });

  return [
    `<!-- Generated by pi-spec-harness at ${generatedAt} — do not edit manually -->`,
    "# RUN-INDEX",
    "",
    "Sorted descending by completion time. Generated and legacy run documents combined.",
    "",
    "| Run ID | Repository | Phase | Spec | Tracking Issue | Completed At | Classification |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

/**
 * Render the `Runs.base` Obsidian DataView base file from sorted entries.
 * Produces static YAML-compatible metadata that Obsidian can filter/sort.
 * SPEC-012, decision 6 / TAC-09.
 */
export function generateObsidianBase(entries: RunIndexEntry[], generatedAt: string): string {
  const sorted = sortRunIndexEntries(entries);

  const runsYaml = sorted.map((e) => {
    const lines = [
      `  - run_id: "${e.runId}"`,
      `    qualified_run_id: "${e.qualifiedRunId}"`,
      `    repository: "${e.repository}"`,
      `    spec: "${e.spec}"`,
      `    phase: "${e.phase}"`,
      `    classification: "${e.classification}"`,
      `    file_path: "${e.filePath}"`,
      `    completed_at: "${e.deliveryMergedAt ?? e.updatedAt ?? ""}"`,
    ];
    if (e.trackingIssue !== null) {
      lines.push(`    tracking_issue: ${e.trackingIssue}`);
    }
    return lines.join("\n");
  });

  return [
    "---",
    `# Obsidian Core Base — generated by pi-spec-harness at ${generatedAt}`,
    "# Do not edit manually; regenerated on every documentation write.",
    "runs:",
    ...runsYaml,
    "---",
    "",
    "This file is managed by pi-spec-harness. Edit individual run snapshots, not this file.",
    "",
  ].join("\n");
}
