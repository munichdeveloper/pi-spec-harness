import { github } from "../github/gh.js";
import { resolveGate, type NextAction } from "../state/state-machine.js";
import type { RunState } from "../state/types.js";

/**
 * Protocol for human gates (see docs/human-gates.md):
 *
 * - Opening a gate creates (or reuses) exactly one GitHub Issue in the
 *   target repository, labeled `harness:gate` and `status:needs-human`.
 * - A human resolves the gate by adding the label `harness:gate-approved`
 *   (approve) or `harness:gate-rejected` (reject), optionally with a
 *   clarifying comment, and the harness records who/when from the issue's
 *   own timeline via `gh`.
 * - The harness never infers approval from chat. Only the issue's labels
 *   count.
 */

export const GATE_LABEL = "harness:gate";
export const GATE_NEEDS_HUMAN_LABEL = "status:needs-human";
export const GATE_APPROVED_LABEL = "harness:gate-approved";
export const GATE_REJECTED_LABEL = "harness:gate-rejected";

export interface OpenHumanGateOptions {
  runState: RunState;
  gateId: string;
  title: string;
  question: string;
  context: string[];
}

export async function openHumanGateIssue(opts: OpenHumanGateOptions): Promise<RunState> {
  const { runState, gateId, title, question, context } = opts;
  const existingGate = runState.gates.find((g) => g.id === gateId);
  if (existingGate?.issue) {
    return runState; // already opened, nothing to do
  }

  const body = [
    `## Human-Gate: ${gateId}`,
    "",
    `**Run:** \`${runState.runId}\` (Repository: ${runState.repository})`,
    `**Requirement:** ${runState.requirement} · **Spec:** ${runState.spec}` +
      (runState.issue ? ` · **Issue:** #${runState.issue}` : "") +
      (runState.pullRequest ? ` · **PR:** #${runState.pullRequest}` : ""),
    "",
    `### Frage / Entscheidungsbedarf`,
    question,
    "",
    ...(context.length > 0 ? ["### Kontext", ...context.map((c) => `- ${c}`), ""] : []),
    "### Entscheidung",
    `Label \`${GATE_APPROVED_LABEL}\` hinzufügen zum Freigeben, oder \`${GATE_REJECTED_LABEL}\` zum Ablehnen. `,
    "Ein klärender Kommentar ist willkommen, zählt aber nicht als Entscheidung -- ausschließlich das Label.",
  ].join("\n");

  await github.ensureLabel(runState.repository, GATE_LABEL, {
    color: "5319E7",
    description: "Harness human gate: blocks until resolved via approve/reject label",
  });
  await github.ensureLabel(runState.repository, GATE_NEEDS_HUMAN_LABEL, {
    color: "D93F0B",
    description: "Waiting on a human decision",
  });
  await github.ensureLabel(runState.repository, GATE_APPROVED_LABEL, {
    color: "0E8A16",
    description: "Harness human gate resolved: approved",
  });
  await github.ensureLabel(runState.repository, GATE_REJECTED_LABEL, {
    color: "B60205",
    description: "Harness human gate resolved: rejected",
  });

  const issue = await github.createIssue(runState.repository, {
    title: `[Human Gate] ${runState.runId} · ${title}`,
    body,
    labels: [GATE_LABEL, GATE_NEEDS_HUMAN_LABEL],
  });

  return resolveGate(runState, gateId, { issue, result: "needs-human" });
}

export interface GateCheckResult {
  resolved: boolean;
  approved?: boolean;
  by?: string;
  at?: string;
  note?: string;
}

export async function checkHumanGateIssue(runState: RunState, gateId: string): Promise<GateCheckResult> {
  const gate = runState.gates.find((g) => g.id === gateId);
  if (!gate?.issue) {
    throw new Error(`gate '${gateId}' has no open GitHub issue yet; call openHumanGateIssue first`);
  }

  const issue = await github.viewIssue(gate.issue.repository, gate.issue.number);
  const labelNames = issue.labels.map((l) => l.name);

  if (labelNames.includes(GATE_APPROVED_LABEL)) {
    return { resolved: true, approved: true, by: "github-issue-label", at: new Date().toISOString() };
  }
  if (labelNames.includes(GATE_REJECTED_LABEL)) {
    return { resolved: true, approved: false, by: "github-issue-label", at: new Date().toISOString() };
  }
  return { resolved: false };
}

export async function applyGateDecision(
  runState: RunState,
  gateId: string,
  decision: GateCheckResult,
): Promise<RunState> {
  if (!decision.resolved) {
    throw new Error(`cannot apply an unresolved decision for gate '${gateId}'`);
  }
  const gate = runState.gates.find((g) => g.id === gateId);
  const next = resolveGate(runState, gateId, {
    result: decision.approved ? "passed" : "failed",
    decision: {
      approved: Boolean(decision.approved),
      by: decision.by ?? "unknown",
      at: decision.at ?? new Date().toISOString(),
      note: decision.note,
    },
  });

  if (gate?.issue) {
    await github.commentIssue(
      gate.issue.repository,
      gate.issue.number,
      decision.approved
        ? `Harness: Gate \`${gateId}\` als **freigegeben** übernommen. Run \`${runState.runId}\` läuft weiter.`
        : `Harness: Gate \`${gateId}\` als **abgelehnt** übernommen. Run \`${runState.runId}\` pausiert.`,
    );
    if (decision.approved) {
      await github.closeIssue(gate.issue.repository, gate.issue.number);
    }
  }

  return next;
}

export function describeNextAction(action: NextAction): string {
  return `${action.action}: ${action.detail}`;
}
