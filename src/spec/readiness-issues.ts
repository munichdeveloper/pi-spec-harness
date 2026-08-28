import { github } from "../github/gh.js";
import type { ReadinessBlocker } from "./readiness.js";
import type { ReadinessWork } from "./readiness-coordinator.js";

type IssueApi = Pick<typeof github, "listReadinessIssues" | "createIssue">;

function marker(key: string): string {
  if (!/^readiness-[a-f0-9]{64}$/.test(key)) throw new Error("Invalid readiness identity");
  return `<!-- harness:readiness:${key} -->`;
}

/** Caller serializes the entire repository/spec reconciliation. No search-index
 * lookup: retries after an ambiguous create inspect the authoritative issue list.
 * Creation/adoption must subsequently be confirmed in the process audit.
 */
export async function ensureReadinessImplementationIssue(
  repository: string,
  input: { key: string; specId: string; title: string; body: string },
  api: IssueApi = github,
): Promise<number> {
  const identity = marker(input.key);
  if (!/^SPEC-\d+$/.test(input.specId)) throw new Error("Invalid spec identity");
  const issues = await api.listReadinessIssues(repository);
  const titlePattern = new RegExp(`^${input.specId}(?=[:\\s]|$)`);
  const candidates = issues.filter(issue => issue.body.includes(identity) || titlePattern.test(issue.title));
  if (candidates.length > 1) throw new Error("Ambiguous readiness implementation issues");
  if (candidates.length === 1) {
    const issue = candidates[0];
    if (issue.state.toLowerCase() !== "open") throw new Error("Existing implementation issue is closed; reconciliation required");
    // Do not adopt an issue already bound to another run/revision identity.
    if (/<!-- harness:readiness:/.test(issue.body) && !issue.body.includes(identity)) {
      throw new Error("Implementation issue has a conflicting readiness identity");
    }
    return issue.number;
  }
  const created = await api.createIssue(repository, {
    title: `${input.specId}: ${input.title}`,
    body: `${input.body}\n\n${identity}`,
    // Execution labels are applied only by the separately validated handoff.
  });
  if (!Number.isSafeInteger(created.number) || created.number <= 0) throw new Error("Invalid issue creation receipt");
  return created.number;
}

export async function ensureReadinessSpikeIssue(
  repository: string,
  input: { specId: string; implementationIssue: number; work: ReadinessWork; blocker: ReadinessBlocker },
  api: IssueApi = github,
): Promise<number> {
  const { work, blocker } = input;
  const identity = marker(work.key);
  if (work.kind !== "spike" || work.blockerId !== blocker.id || blocker.kind !== "technical"
    || blocker.stage !== "implementation" || !Number.isSafeInteger(work.attempt)
    || work.attempt < 1 || work.attempt > blocker.maxAttempts
    || !Number.isSafeInteger(input.implementationIssue) || input.implementationIssue <= 0) {
    throw new Error("Invalid spike work binding");
  }
  const matches = (await api.listReadinessIssues(repository)).filter(issue => issue.body.includes(identity));
  if (matches.length > 1) throw new Error("Ambiguous readiness spike issues");
  // A closed spike is still the same work item, not evidence of successful research.
  if (matches.length === 1) return matches[0].number;
  const created = await api.createIssue(repository, {
    title: `[Spike] ${input.specId}: ${blocker.id} (attempt ${work.attempt})`,
    body: [
      `Implementation: #${input.implementationIssue}`, `Spec revision: ${work.revision}`,
      `Owner: ${blocker.owner}`, `Executor: ${work.executorId}`,
      `Attempt: ${work.attempt}/${blocker.maxAttempts}`, "", "## Question", "", blocker.question,
      "", "## Required evidence", "", ...blocker.criteria.map(criterion => `- ${criterion}`),
      "", "Closing this issue does not resolve the blocker. A verified, revision-bound result is required.",
      "Scope, cost or privacy changes require a human decision; no implicit provider fallback.", "", identity,
    ].join("\n"),
  });
  if (!Number.isSafeInteger(created.number) || created.number <= 0) throw new Error("Invalid spike creation receipt");
  return created.number;
}
