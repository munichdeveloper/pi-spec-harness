/**
 * Requirement-to-Spec agent pipeline: pure classification and dispatch
 * contract for SPEC-014.
 *
 * All functions here are pure — no I/O, no GitHub calls.  Side-effects
 * (GitHub writes, outbox persistence) belong in the CLI command or the
 * skill protocol, not here.
 */

import { parseFrontmatter } from "./spec-parser.js";

// ---------------------------------------------------------------------------
// Requirement frontmatter types
// ---------------------------------------------------------------------------

export interface RequirementFrontmatter {
  id: string;
  type: string;
  title: string;
  status: string;
  owner?: string;
  risk?: string;
  created?: string;
  updated?: string;
}

// ---------------------------------------------------------------------------
// Provider-neutral dispatch contract  (SPEC-014, decision 2 / TAC-04)
// ---------------------------------------------------------------------------

export type SpecGenerationProvider = "github-copilot" | "claude-code";

/**
 * The provider-neutral spec-generation dispatch order.
 * Callers build this value from `buildSpecDispatchOrder` and hand it to a
 * provider adapter that converts it into GitHub API calls.
 */
export interface SpecDispatchOrder {
  /** Stable idempotency key: `<repository>:<req-id>:<source-sha>`. */
  dispatchKey: string;
  /** Target repository (owner/repo). */
  repository: string;
  /** Source requirement identifier (e.g. "REQ-014"). */
  requirementId: string;
  /** Commit SHA of the merged requirement document. */
  sourceSha: string;
  /** Absolute path (repo-relative) of the requirement file. */
  requirementPath: string;
  /** Desired output path for the generated spec. */
  targetSpecPath: string;
  /** Branch the agent should work on. */
  agentBranch: string;
  /** Chosen generation provider. */
  provider: SpecGenerationProvider;
  /**
   * Mandatory sections the generated spec must contain.
   * TAC-05: validated before the PR is accepted.
   */
  requiredSections: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Parse and validate the frontmatter of a merged requirement document.
 * Returns the structured frontmatter on success; throws on invalid input.
 * SPEC-014, TAC-01.
 */
export function parseRequirementFrontmatter(content: string): RequirementFrontmatter {
  const raw = parseFrontmatter(content);

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const type = typeof raw.type === "string" ? raw.type.trim() : "";
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const status = typeof raw.status === "string" ? raw.status.trim() : "";

  if (!id) throw new Error("Requirement frontmatter missing required field 'id'");
  if (!type) throw new Error("Requirement frontmatter missing required field 'type'");
  if (!title) throw new Error("Requirement frontmatter missing required field 'title'");
  if (!status) throw new Error("Requirement frontmatter missing required field 'status'");

  return {
    id,
    type,
    title,
    status,
    owner: typeof raw.owner === "string" ? raw.owner.trim() : undefined,
    risk: typeof raw.risk === "string" ? raw.risk.trim() : undefined,
    created: typeof raw.created === "string" ? raw.created.trim() : undefined,
    updated: typeof raw.updated === "string" ? raw.updated.trim() : undefined,
  };
}

/**
 * Return true when the requirement is eligible for spec-generation dispatch.
 *
 * Eligibility rules (SPEC-014, TAC-01):
 * - `type` must be "requirement"
 * - `status` must be "approved"
 */
export function isRequirementEligible(fm: RequirementFrontmatter): boolean {
  return fm.type === "requirement" && fm.status === "approved";
}

/**
 * Derive the canonical spec output path from a requirement id.
 * Convention: `docs/specifications/SPEC-NNN-<slug>.md`
 * The NNN portion mirrors the numeric part of the REQ id.
 * SPEC-014, decision 3.
 */
export function deriveSpecPath(requirementId: string, specGlob = "docs/specifications"): string {
  const numericMatch = requirementId.match(/(\d+)/);
  const numericPart = numericMatch ? numericMatch[1].padStart(3, "0") : "000";
  const slugPart = requirementId
    .toLowerCase()
    .replace(/^req-?0*(\d+)/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const specId = `SPEC-${numericPart}`;
  const filename = slugPart.length > 0 ? `${specId}${slugPart}.md` : `${specId}.md`;
  return `${specGlob}/${filename}`;
}

/**
 * Build the stable dispatch key for a spec-generation order.
 * Key = `<repository>:<req-id>:<source-sha>` (all lower-cased).
 * SPEC-014, decision 2.
 */
export function buildDispatchKey(repository: string, requirementId: string, sourceSha: string): string {
  return `${repository.toLowerCase()}:${requirementId.toLowerCase()}:${sourceSha.toLowerCase()}`;
}

/**
 * Build a fully populated `SpecDispatchOrder` from validated inputs.
 * All fields that would require I/O to determine (e.g. SHA) must be
 * supplied by the caller. SPEC-014, TAC-04.
 */
export function buildSpecDispatchOrder(opts: {
  repository: string;
  requirementId: string;
  sourceSha: string;
  requirementPath: string;
  targetSpecPath?: string;
  agentBranch?: string;
  provider?: SpecGenerationProvider;
}): SpecDispatchOrder {
  const targetSpecPath = opts.targetSpecPath ?? deriveSpecPath(opts.requirementId);
  const agentBranch = opts.agentBranch ?? `harness/spec-gen-${opts.requirementId.toLowerCase()}-${opts.sourceSha.slice(0, 8)}`;
  const provider = opts.provider ?? "github-copilot";
  const dispatchKey = buildDispatchKey(opts.repository, opts.requirementId, opts.sourceSha);

  return {
    dispatchKey,
    repository: opts.repository,
    requirementId: opts.requirementId,
    sourceSha: opts.sourceSha,
    requirementPath: opts.requirementPath,
    targetSpecPath,
    agentBranch,
    provider,
    requiredSections: [
      "Architektur",
      "Technische Entscheidungen",
      "Technische Akzeptanzkriterien",
      "Rollback",
    ],
  };
}
