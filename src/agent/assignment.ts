export const DEFAULT_CODING_AGENT = "copilot-swe-agent[bot]";

import type { RunState } from "../state/types.js";

export function normalizeAgentLogin(login: string): string {
  return login.replace(/^@/, "").toLowerCase();
}

export function extractReferencedIssueNumbers(body: string): number[] {
  return [...new Set([...body.matchAll(/(?:issues\/|#)(\d+)/gi)].map((match) => Number(match[1])))]
    .filter((number) => Number.isSafeInteger(number) && number > 0);
}

export function recordVerifiedAgentAssignment(
  state: RunState,
  assignment: NonNullable<RunState["agentAssignment"]>,
): { state: RunState; supersededGateIds: string[] } {
  // Assignment evidence is recorded independently. An existing human gate is
  // never silently converted into a pass: demonstrable false positives must
  // use the named, audited gate-supersede operation (issue #83).
  return {
    state: { ...state, agentAssignment: assignment, updatedAt: assignment.verifiedAt },
    supersededGateIds: [],
  };
}

export async function pollForAgentAssignment<T extends { assignees: Array<{ login: string }> }>(
  read: () => Promise<T>,
  expectedLogin: string,
  options: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ issue: T; assigned: boolean; attempts: number }> {
  const attempts = options.attempts ?? 4;
  const delayMs = options.delayMs ?? 1000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const expected = normalizeAgentLogin(expectedLogin);
  let issue!: T;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    issue = await read();
    if (issue.assignees.some((assignee) => normalizeAgentLogin(assignee.login) === expected)) {
      return { issue, assigned: true, attempts: attempt };
    }
    if (attempt < attempts) await sleep(delayMs * attempt);
  }
  return { issue, assigned: false, attempts };
}
