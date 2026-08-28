import { github } from "../github/gh.js";
import { assertHygiene } from "../state/hygiene.js";
import { parseStateFromBody, renderStateBody, RUN_ISSUE_LABEL, runIssueTitle } from "../state/issue-store.js";
import { initRunState, reconcileInit } from "../state/state-machine.js";
import type { RunState } from "../state/types.js";

type RunApi = Pick<typeof github, "listReadinessIssues" | "ensureLabel" | "createIssue">;

export interface ReadinessRunInput {
  repository: string;
  specId: string;
  requirementId: string;
  specPath: string;
  /** Supplied only after the trusted entry point verified the approved artifact. */
  approvedRevision: string;
  approvalEvidence: string;
  implementationIssue?: number;
}

/** Called under the same repository/spec lock as issue materialization. Adopt
 * existing canonical state, including legacy run names, before creating anything.
 * Returning a closed run is forbidden: it needs reconciliation, not a second run.
 */
export async function ensureReadinessRun(input: ReadinessRunInput, api: RunApi = github): Promise<{
  issue: { repository: string; number: number; url: string };
  state: RunState;
  created: boolean;
}> {
  if (!/^SPEC-\d+$/.test(input.specId) || !/^REQ-\d+$/.test(input.requirementId)
    || !/^[a-f0-9]{40}$/.test(input.approvedRevision) || !input.approvalEvidence.trim()
    || !input.specPath.trim()
    || (input.implementationIssue !== undefined && (!Number.isSafeInteger(input.implementationIssue) || input.implementationIssue <= 0))) {
    throw new Error("Invalid readiness run provenance");
  }
  const runId = `readiness-${input.specId.toLowerCase()}`;
  const issues = await api.listReadinessIssues(input.repository);
  const matches: Array<{ issue: typeof issues[number]; state: RunState }> = [];
  for (const issue of issues) {
    if (!issue.body.includes("<!-- harness:state:begin -->") && !issue.title.startsWith("[Harness Run]")) continue;
    let state: RunState;
    try { state = parseStateFromBody(issue.body); }
    catch { throw new Error(`Unreadable canonical run #${issue.number}; refusing duplicate creation`); }
    if (state.spec === input.specId || issue.title === runIssueTitle(runId)
      || (input.implementationIssue !== undefined && state.issue === input.implementationIssue)) {
      matches.push({ issue, state });
    }
  }
  if (matches.length > 1) throw new Error("Multiple canonical runs match readiness handoff");
  if (matches.length === 1) {
    const { issue, state } = matches[0];
    if (issue.state.toLowerCase() !== "open" || state.phase === "complete") throw new Error("Readiness run already closed or complete; reconciliation required");
    reconcileInit(state, { runId: state.runId, repository: input.repository, requirement: input.requirementId, spec: input.specId, issue: input.implementationIssue });
    if (state.specPath && state.specPath !== input.specPath) throw new Error("Readiness spec path conflicts with canonical run");
    return { issue: { repository: input.repository, number: issue.number, url: issue.url }, state, created: false };
  }
  const state = initRunState({ runId, repository: input.repository, requirement: input.requirementId,
    spec: input.specId, specPath: input.specPath, issue: input.implementationIssue });
  state.phase = "issue";
  state.gates.push({ id: "readiness-spec-provenance", type: "spec", result: "passed",
    createdAt: state.createdAt, updatedAt: state.updatedAt,
    evidence: [input.approvalEvidence, `approved-spec-revision:${input.approvedRevision}`] });
  assertHygiene(state);
  await api.ensureLabel(input.repository, RUN_ISSUE_LABEL, { color: "1D76DB", description: "Persistent tracking issue for one pi-spec-harness run" });
  const issue = await api.createIssue(input.repository, { title: runIssueTitle(runId), body: renderStateBody(state), labels: [RUN_ISSUE_LABEL] });
  if (!Number.isSafeInteger(issue.number) || issue.number <= 0) throw new Error("Invalid canonical run creation receipt");
  return { issue, state, created: true };
}
