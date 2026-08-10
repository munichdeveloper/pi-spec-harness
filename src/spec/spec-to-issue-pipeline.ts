import { readFile } from "node:fs/promises";
import { github } from "../github/gh.js";
import { buildIssueFromSpec, IssueFromSpecError, parseSpecFrontmatterForIssue } from "./issue-from-spec.js";

export type SpecToIssuePipelineResult =
  | { action: "skipped-not-approved"; specId?: string; status?: string; reason: string }
  | { action: "skipped-duplicate"; specId: string; existingIssue: { number: number; url: string } }
  | { action: "created"; specId: string; issue: { number: number; url: string } };

/**
 * SPEC-007: the single, reusable implementation behind both a direct CLI
 * invocation and the `spec-to-issue.yml` reactive pipeline. Reads a spec
 * file from disk (already checked out by the caller -- either a developer
 * locally or the GitHub Actions checkout step), and either creates exactly
 * one implementation issue or explains why it skipped.
 *
 * AC-08: never sets ai:allowed/status:ready on the created issue; those are
 * exclusively set by the separate label-approval-bundling gate.
 */
export async function runSpecToIssuePipeline(options: {
  repository: string;
  specPath: string;
}): Promise<SpecToIssuePipelineResult> {
  const specContent = await readFile(options.specPath, "utf-8");

  let specId: string | undefined;
  try {
    specId = parseSpecFrontmatterForIssue(specContent).id || undefined;
  } catch {
    // fall through; buildIssueFromSpec will raise a clearer error below
  }

  let built;
  try {
    built = buildIssueFromSpec(specContent, { specPath: options.specPath });
  } catch (err) {
    if (err instanceof IssueFromSpecError) {
      return {
        action: "skipped-not-approved",
        specId,
        reason: err.message,
      };
    }
    throw err;
  }

  // TAC-04/TAC-06/TAC-07: broad idempotency search by spec-id in title,
  // finds issues created either by this pipeline or by
  // `harness issue-create --from-spec-path`.
  const existingMatches = await github.findIssuesByTitleContains(options.repository, specId ?? built.title);
  if (existingMatches.length > 0) {
    return {
      action: "skipped-duplicate",
      specId: specId ?? built.title,
      existingIssue: { number: existingMatches[0].number, url: existingMatches[0].url },
    };
  }

  const issueRef = await github.createIssue(options.repository, {
    title: built.title,
    body: built.body,
  });

  return {
    action: "created",
    specId: specId ?? built.title,
    issue: { number: issueRef.number, url: issueRef.url },
  };
}
