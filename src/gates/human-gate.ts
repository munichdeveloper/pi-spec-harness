import { github } from "../github/gh.js";
import { acknowledgeRejectedGate, resolveGate, type NextAction } from "../state/state-machine.js";
import type { HumanGateIssueRef, RunState } from "../state/types.js";

/**
 * Protocol for human gates (see docs/human-gates.md):
 *
 * - A run has exactly one persistent tracking issue (see src/state/issue-store.ts).
 *   Opening a human gate reuses that same issue instead of creating a new
 *   one: it adds `status:needs-human` + `harness:gate-open`, and appends a
 *   comment with the question and context. The issue body always reflects
 *   the full current run-state (see issue-store.ts renderStateBody).
 * - A human resolves the gate by adding the label `harness:gate-approved`
 *   (approve) or `harness:gate-rejected` (reject) to that same issue,
 *   optionally with a clarifying comment. The harness never infers approval
 *   from chat or from comment text -- only these two labels count.
 * - Resolving a gate removes the transient labels
 *   (`status:needs-human`, `harness:gate-open`, and whichever decision label
 *   was set) so the same issue is clean for the run's next gate cycle.
 * - The tracking issue is only closed once the whole run reaches phase
 *   'complete'.
 */

export const GATE_LABEL = "harness:gate-open";
export const GATE_NEEDS_HUMAN_LABEL = "status:needs-human";
export const GATE_APPROVED_LABEL = "harness:gate-approved";
export const GATE_REJECTED_LABEL = "harness:gate-rejected";

async function ensureGateLabels(repository: string): Promise<void> {
  await github.ensureLabel(repository, GATE_LABEL, {
    color: "5319E7",
    description: "Harness human gate is currently open on this run issue",
  });
  await github.ensureLabel(repository, GATE_NEEDS_HUMAN_LABEL, {
    color: "D93F0B",
    description: "Waiting on a human decision",
  });
  await github.ensureLabel(repository, GATE_APPROVED_LABEL, {
    color: "0E8A16",
    description: "Harness human gate resolved: approved",
  });
  await github.ensureLabel(repository, GATE_REJECTED_LABEL, {
    color: "B60205",
    description: "Harness human gate resolved: rejected",
  });
}

export interface OpenHumanGateOptions {
  runState: RunState;
  gateId: string;
  title: string;
  question: string;
  context: string[];
  /** The run's persistent tracking issue. Required -- see issue-store.ts. */
  runIssue: HumanGateIssueRef;
}

export async function openHumanGateIssue(opts: OpenHumanGateOptions): Promise<RunState> {
  const { runState, gateId, title, question, context, runIssue } = opts;
  const existingGate = runState.gates.find((g) => g.id === gateId);
  if (existingGate?.issue) {
    return runState; // already opened, nothing to do
  }

  await ensureGateLabels(runIssue.repository);
  await github.addLabels(runIssue.repository, runIssue.number, [GATE_LABEL, GATE_NEEDS_HUMAN_LABEL]);

  const comment = [
    `## Human-Gate: ${gateId} -- ${title}`,
    "",
    `### Frage / Entscheidungsbedarf`,
    question,
    "",
    ...(context.length > 0 ? ["### Kontext", ...context.map((c) => `- ${c}`), ""] : []),
    "### Entscheidung",
    `Label \`${GATE_APPROVED_LABEL}\` hinzufügen zum Freigeben, oder \`${GATE_REJECTED_LABEL}\` zum Ablehnen. `,
    "Ein klärender Kommentar ist willkommen, zählt aber nicht als Entscheidung -- ausschließlich das Label.",
  ].join("\n");
  await github.commentIssue(runIssue.repository, runIssue.number, comment);

  return resolveGate(runState, gateId, { issue: runIssue, result: "needs-human" });
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
    // Reset transient labels so the same tracking issue is clean for the
    // run's next gate cycle instead of accumulating stale decision labels.
    await github.removeLabels(gate.issue.repository, gate.issue.number, [
      GATE_LABEL,
      GATE_NEEDS_HUMAN_LABEL,
      GATE_APPROVED_LABEL,
      GATE_REJECTED_LABEL,
    ]);
  }

  return next;
}

/**
 * Acknowledge a rejected human gate: records how the run proceeds. Unlike
 * the old per-gate-issue design, this never closes the tracking issue --
 * only reaching phase 'complete' does (see closeRunIssue in issue-store
 * consumers).
 */
export async function acknowledgeRejectedHumanGate(
  runState: RunState,
  gateId: string,
  note: string,
): Promise<RunState> {
  const gate = runState.gates.find((g) => g.id === gateId);
  const next = acknowledgeRejectedGate(runState, gateId, note);

  if (gate?.issue) {
    await github.commentIssue(gate.issue.repository, gate.issue.number, `Harness: Ablehnung quittiert. ${note}`);
  }

  return next;
}

export function describeNextAction(action: NextAction): string {
  return `${action.action}: ${action.detail}`;
}
