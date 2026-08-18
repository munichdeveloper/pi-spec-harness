/**
 * Pure, deterministic Markdown snapshot renderer for a completed run.
 * SPEC-012, decision 4 / TAC-06 / TAC-07.
 *
 * Rules:
 * - The function is pure: same input → same byte-identical output.
 * - Only allowlisted fields from RunState are rendered.
 * - Unknown optional values are rendered as `null` or "unknown".
 * - Free-text is never summarized; notes are cited only if present.
 * - No LLM or external SaaS calls. TAC-19.
 */

import type { HumanGateIssueRef, RunState } from "../state/types.js";

export interface RunSnapshotInput {
  state: RunState;
  trackingIssue: HumanGateIssueRef;
  repositoryDefaultBranch: string;
  harnessVersion: string;
  /** Override the snapshot generation timestamp. When absent the snapshot's
   *  `documentationSnapshot.generatedAt` is used. SPEC-012 TAC-06 (idempotency
   *  on retry: same generatedAt → byte-identical output). */
  generatedAt?: string;
}

/**
 * Slugify a string for use in a filename. Converts to lower-case,
 * replaces non-alphanumeric characters with hyphens, collapses runs,
 * and trims leading/trailing hyphens.
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build the canonical snapshot filename from a run-ID and a title/spec slug.
 * Format: `<RUN-ID>-<slugified-spec-or-title>.md`
 * SPEC-012, decision 5.
 */
export function buildSnapshotFilename(runId: string, specOrTitle: string): string {
  return `${runId}-${slugify(specOrTitle)}.md`;
}

/** Render null-safe: returns "null" for undefined/null, otherwise the value. */
function nullable(v: unknown): string {
  return v == null ? "null" : String(v);
}

/** Render an ISO timestamp or "null". */
function ts(v: string | undefined): string {
  return nullable(v);
}

/**
 * Render the run snapshot as a Markdown document with YAML frontmatter.
 * The function is pure: identical input → identical output. SPEC-012 TAC-06.
 */
export function renderRunSnapshot(input: RunSnapshotInput): string {
  const { state, trackingIssue, repositoryDefaultBranch, harnessVersion } = input;
  const snap = state.documentationSnapshot;
  // Use the explicit generatedAt override when provided (ensures byte-identical
  // output on retry by using the same persisted timestamp). Fall back to the
  // checkpoint's own generatedAt, then to null.
  const effectiveGeneratedAt = input.generatedAt ?? snap?.generatedAt ?? null;

  // Sort gates stably by id for deterministic output.
  const sortedGates = [...state.gates].sort((a, b) => a.id.localeCompare(b.id));
  // Sort iterations by index.
  const sortedIterations = [...state.iterations].sort((a, b) => a.index - b.index);
  // Sort reviews by reviewId, then submittedAt.
  const sortedReviews = [...(state.reviews ?? [])].sort((a, b) =>
    a.reviewId !== b.reviewId ? a.reviewId - b.reviewId : a.submittedAt.localeCompare(b.submittedAt),
  );
  // Sort review threads by idempotency key for stable order.
  const sortedThreads = [...(state.reviewThreads ?? [])].sort((a, b) =>
    a.idempotencyKey.localeCompare(b.idempotencyKey),
  );

  // YAML frontmatter (schema_version: 1 per SPEC-012 decision 2)
  const frontmatter = [
    "---",
    "schema_version: 1",
    `run_id: "${state.runId}"`,
    `qualified_run_id: "${trackingIssue.repository}#${state.runId}"`,
    `repository: "${state.repository}"`,
    `requirement: "${state.requirement}"`,
    `spec: "${state.spec}"`,
    `tracking_issue: ${trackingIssue.number}`,
    `tracking_issue_url: "${trackingIssue.url}"`,
    `phase: "${state.phase}"`,
    `created_at: "${ts(state.createdAt)}"`,
    `updated_at: "${ts(state.updatedAt)}"`,
    `delivery_merged_at: "${ts(state.deliveryMergedAt)}"`,
    `delivery_merge_commit_sha: "${nullable(state.deliveryMergeCommitSha)}"`,
    `snapshot_commit_sha: "${nullable(snap?.commitSha)}"`,
    `snapshot_generated_at: "${nullable(effectiveGeneratedAt)}"`,
    `source_head_sha: "${nullable(snap?.sourceHeadSha)}"`,
    `default_branch: "${repositoryDefaultBranch}"`,
    `harness_version: "${harnessVersion}"`,
    `generated: true`,
    `legacy: false`,
    "---",
  ].join("\n");

  // Identity and status section
  const identitySection = [
    "## Identity and Status",
    "",
    `| Field | Value |`,
    `|---|---|`,
    `| Run ID | \`${state.runId}\` |`,
    `| Repository | ${state.repository} |`,
    `| Requirement | ${state.requirement} |`,
    `| Spec | ${state.spec} |`,
    `| Tracking Issue | [#${trackingIssue.number}](${trackingIssue.url}) |`,
    `| Phase | \`${state.phase}\` |`,
    `| Created | ${ts(state.createdAt)} |`,
    `| Updated | ${ts(state.updatedAt)} |`,
    `| Default Branch | ${repositoryDefaultBranch} |`,
  ].join("\n");

  // Delivery section
  const deliverySection = [
    "## Delivery",
    "",
    `| Field | Value |`,
    `|---|---|`,
    ...(state.issue !== undefined ? [`| Issue | #${state.issue} |`] : []),
    ...(state.branch ? [`| Branch | \`${state.branch}\` |`] : []),
    ...(state.requirementPath ? [`| Requirement Path | \`${state.requirementPath}\` |`] : []),
    ...(state.specPath ? [`| Spec Path | \`${state.specPath}\` |`] : []),
    ...(state.implementationPullRequest !== undefined
      ? [`| Implementation PR | #${state.implementationPullRequest}${state.implementationHeadSha ? ` (sha: \`${state.implementationHeadSha}\`)` : ""} |`]
      : []),
    ...(state.deliveryPullRequest !== undefined
      ? [`| Delivery PR | #${state.deliveryPullRequest}${state.deliveryHeadSha ? ` (sha: \`${state.deliveryHeadSha}\`)` : ""} |`]
      : state.pullRequest !== undefined
        ? [`| Delivery PR | #${state.pullRequest}${state.pullRequestHeadSha ? ` (sha: \`${state.pullRequestHeadSha}\`)` : ""} |`]
        : []),
    `| Delivery Merge Commit | ${nullable(state.deliveryMergeCommitSha)} |`,
    `| Delivery Merged At | ${ts(state.deliveryMergedAt)} |`,
  ].join("\n");

  // Gates section
  const gatesSection = [
    "## Gates",
    "",
    sortedGates.length === 0
      ? "_No gates recorded._"
      : [
          "| ID | Type | Result | Opened At | Decision |",
          "|---|---|---|---|---|",
          ...sortedGates.map((g) =>
            `| \`${g.id}\` | ${g.type} | ${g.result} | ${ts(g.openedAt)} | ${g.decision ? `${g.decision.approved ? "approved" : "rejected"} by ${g.decision.by} at ${g.decision.at}` : "null"} |`,
          ),
        ].join("\n"),
  ].join("\n");

  // Iterations section
  const iterationsSection = [
    "## Iterations",
    "",
    sortedIterations.length === 0
      ? "_No iterations recorded._"
      : [
          "| Index | Started | Finished | Result |",
          "|---|---|---|---|",
          ...sortedIterations.map((it) =>
            `| ${it.index} | ${ts(it.startedAt)} | ${ts(it.finishedAt)} | ${nullable(it.result)} |`,
          ),
        ].join("\n"),
  ].join("\n");

  // Reviews section
  const reviewsSection = [
    "## Reviews",
    "",
    sortedReviews.length === 0
      ? "_No reviews recorded._"
      : [
          "| Review ID | Reviewer | State | Submitted At | Iteration |",
          "|---|---|---|---|---|",
          ...sortedReviews.map((r) =>
            `| ${r.reviewId} | ${r.reviewer} | ${r.state} | ${ts(r.submittedAt)} | ${nullable(r.iterationIndex)} |`,
          ),
        ].join("\n"),
  ].join("\n");

  // Review threads section
  const threadsSection = [
    "## Review Threads",
    "",
    sortedThreads.length === 0
      ? "_No review threads recorded._"
      : [
          "| Thread ID | PR | Status | Reviewer |",
          "|---|---|---|---|",
          ...sortedThreads.map((t) =>
            `| \`${t.threadId}\` | #${t.pullRequest} | ${t.status} | ${t.reviewer} |`,
          ),
        ].join("\n"),
  ].join("\n");

  // Snapshot and audit section
  const snapshotSection = [
    "## Documentation Snapshot",
    "",
    snap
      ? [
          `| Field | Value |`,
          `|---|---|`,
          `| Status | ${snap.status} |`,
          `| Path | \`${snap.path}\` |`,
          `| Index Path | \`${snap.indexPath}\` |`,
          `| Obsidian Base Path | \`${snap.obsidianBasePath}\` |`,
          `| Generated At | ${snap.generatedAt} |`,
          `| Source Head SHA | \`${snap.sourceHeadSha}\` |`,
          `| Commit SHA | ${nullable(snap.commitSha)} |`,
          `| Audit Idempotency Key | \`${snap.auditIdempotencyKey}\` |`,
          `| Audit Confirmed At | ${ts(snap.auditConfirmedAt)} |`,
        ].join("\n")
      : "_No documentation snapshot checkpoint recorded._",
  ].join("\n");

  // Notes section (read-only citation; no prose generated)
  const notesSection =
    state.notes && state.notes.length > 0
      ? [
          "## Notes",
          "",
          "_The following structured notes are cited from the run state as-is:_",
          "",
          ...state.notes.map((n) => `- ${n}`),
        ].join("\n")
      : "";

  // Harness metadata
  const harnessSection = [
    "## Harness Metadata",
    "",
    `| Field | Value |`,
    `|---|---|`,
    `| Harness Version | ${harnessVersion} |`,
    `| Schema Version | ${state.schemaVersion} |`,
    `| Source Head SHA | ${nullable(snap?.sourceHeadSha)} |`,
    `| Audit Idempotency Key | ${nullable(snap?.auditIdempotencyKey)} |`,
    `| Audit Confirmed At | ${ts(snap?.auditConfirmedAt)} |`,
  ].join("\n");

  const sections = [
    `# Run Snapshot: ${state.runId}`,
    "",
    identitySection,
    "",
    deliverySection,
    "",
    gatesSection,
    "",
    iterationsSection,
    "",
    reviewsSection,
    "",
    threadsSection,
    "",
    snapshotSection,
    ...(notesSection ? ["", notesSection] : []),
    "",
    harnessSection,
    "",
  ];

  return [frontmatter, "", ...sections].join("\n");
}

export type { RunSnapshotInput as RunSnapshotOptions };
