import { github } from "../github/gh.js";
import { assertHygiene } from "./hygiene.js";
import type { StateStore } from "./state-store.js";
import type { RunState } from "./types.js";

export const RUN_ISSUE_LABEL = "harness:run";

const STATE_BEGIN = "<!-- harness:state:begin -->";
const STATE_END = "<!-- harness:state:end -->";
const STATE_BLOCK = new RegExp(`${STATE_BEGIN}\\s*\`\`\`json\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\`\\s*${STATE_END}`);

export function runIssueTitle(runId: string): string {
  return `[Harness Run] ${runId}`;
}

/**
 * Render the full run-state as a GitHub issue body: a human-readable
 * summary on top, and the canonical, machine-readable JSON in a clearly
 * marked, collapsible block at the bottom. The JSON block is the single
 * source of truth; the summary is regenerated from it on every save.
 */
export function renderStateBody(state: RunState): string {
  const openGate = state.gates.find((g) => g.type === "human" && (g.result === "pending" || g.result === "needs-human"));
  const gateRows = state.gates
    .map((g) => `| \`${g.id}\` | ${g.type} | ${g.result} |`)
    .join("\n");

  const summary = [
    `## Harness Run: \`${state.runId}\``,
    "",
    `**Repository:** ${state.repository} · **Requirement:** ${state.requirement} · **Spec:** ${state.spec}` +
      (state.issue ? ` · **Issue:** #${state.issue}` : "") +
      (state.deliveryPullRequest
        ? ` · **Delivery-PR:** #${state.deliveryPullRequest}`
        : state.pullRequest
          ? ` · **PR:** #${state.pullRequest}`
          : "") +
      (state.implementationPullRequest ? ` · **Impl-PR:** #${state.implementationPullRequest}` : ""),
    `**Phase:** \`${state.phase}\` · **Iterationen:** ${state.iterations.length}/${state.maxAutomaticIterations}`,
    "",
    ...(openGate
      ? [
          `### Offenes Human-Gate: \`${openGate.id}\``,
          openGate.question ?? "",
          "",
          `Label \`harness:gate-approved\` zum Freigeben, \`harness:gate-rejected\` zum Ablehnen.`,
          "",
        ]
      : []),
    "### Gates",
    "| id | type | result |",
    "|---|---|---|",
    gateRows.length > 0 ? gateRows : "| _keine_ | | |",
    "",
  ].join("\n");

  const jsonBlock = ["```json", JSON.stringify(state, null, 2), "```"].join("\n");

  return [summary, "<details><summary>Rohdaten (maschinenlesbar, kanonisch)</summary>", "", STATE_BEGIN, jsonBlock, STATE_END, "", "</details>"].join(
    "\n",
  );
}

export function parseStateFromBody(body: string): RunState {
  const match = body.match(STATE_BLOCK);
  if (!match) {
    throw new Error("issue body does not contain a harness:state block");
  }
  return JSON.parse(match[1]) as RunState;
}

export class IssueStateStore implements StateStore {
  readonly issueRef: { repository: string; number: number; url: string };

  constructor(repository: string, issueNumber: number, url?: string) {
    this.issueRef = { repository, number: issueNumber, url: url ?? `https://github.com/${repository}/issues/${issueNumber}` };
  }

  async load(): Promise<RunState> {
    const issue = await github.viewIssue(this.issueRef.repository, this.issueRef.number);
    return parseStateFromBody(issue.body);
  }

  async save(state: RunState): Promise<void> {
    assertHygiene(state);
    const body = renderStateBody(state);
    await github.updateIssueBody(this.issueRef.repository, this.issueRef.number, body);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find the existing tracking issue for a run, if any.
 *
 * GitHub's issue search index lags issue creation by a second or two, so a
 * `gate-open` called immediately after `init` can otherwise fail to find an
 * issue that demonstrably exists. Retry briefly with backoff before giving
 * up, instead of forcing every caller to work around eventual consistency.
 */
export async function findRunIssue(
  repository: string,
  runId: string,
  retry: { attempts: number; delayMs: number } = { attempts: 4, delayMs: 1500 },
): Promise<IssueStateStore | undefined> {
  const title = runIssueTitle(runId);
  for (let attempt = 1; attempt <= retry.attempts; attempt++) {
    const found = await github.findIssueByExactTitle(repository, title);
    if (found) return new IssueStateStore(found.repository, found.number, found.url);
    if (attempt < retry.attempts) await sleep(retry.delayMs);
  }
  return undefined;
}

/**
 * Find-or-create the persistent tracking issue for a run. Creating it also
 * writes the initial state into its body immediately.
 */
export async function ensureRunIssue(repository: string, runId: string, initialState: RunState): Promise<IssueStateStore> {
  // No retry here: if the issue genuinely does not exist yet, we want to
  // create it immediately rather than wait out the search-index lag.
  const existing = await findRunIssue(repository, runId, { attempts: 1, delayMs: 0 });
  if (existing) return existing;

  await github.ensureLabel(repository, RUN_ISSUE_LABEL, {
    color: "1D76DB",
    description: "Persistent tracking issue for one pi-spec-harness run",
  });

  const created = await github.createIssue(repository, {
    title: runIssueTitle(runId),
    body: renderStateBody(initialState),
    labels: [RUN_ISSUE_LABEL],
  });
  return new IssueStateStore(created.repository, created.number, created.url);
}
