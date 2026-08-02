import { github } from "../github/gh.js";
import { acknowledgeRejectedGate, resolveGate, type NextAction } from "../state/state-machine.js";
import type { GateDecisionContext, HumanGateIssueRef, RunState } from "../state/types.js";

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
  /** Structured decision context stored in GateRecord (TAC-01). */
  decisionContext?: GateDecisionContext;
  /** The run's persistent tracking issue. Required -- see issue-store.ts. */
  runIssue: HumanGateIssueRef;
}

/**
 * Pure preparation step. Callers must persist its result before invoking
 * publishHumanGateIssue so a crash can resume without duplicating the gate.
 */
export function prepareHumanGateIssue(opts: OpenHumanGateOptions): RunState {
  const { runState, gateId, title, context, decisionContext, runIssue } = opts;
  const existingGate = runState.gates.find((g) => g.id === gateId);
  if (existingGate?.issue) {
    return runState;
  }
  const openedAt = new Date().toISOString();
  const marker = `<!-- harness:gate-open:${runState.runId}:${gateId}:${openedAt} -->`;
  return resolveGate(runState, gateId, {
    issue: runIssue,
    result: "needs-human",
    openedAt,
    context: decisionContext,
    publication: { status: "prepared", marker, title, legacyContext: context },
  });
}

/** Publish a prepared gate idempotently and return its completed checkpoint. */
export async function publishHumanGateIssue(runState: RunState, gateId: string): Promise<RunState> {
  const gate = runState.gates.find((candidate) => candidate.id === gateId);
  if (!gate?.issue) throw new Error(`gate '${gateId}' is not prepared for publication`);
  if (!gate.publication) return runState; // backward-compatible already-open gate
  if (gate.publication.status === "open") return runState;

  const { issue, publication } = gate;
  await ensureGateLabels(issue.repository);
  await github.removeLabels(issue.repository, issue.number, [GATE_APPROVED_LABEL, GATE_REJECTED_LABEL]);
  await github.addLabels(issue.repository, issue.number, [GATE_LABEL, GATE_NEEDS_HUMAN_LABEL]);

  const comment = [
    publication.marker,
    `## Human-Gate: ${gateId} -- ${publication.title}`,
    "",
    `### Frage / Entscheidungsbedarf`,
    gate.question ?? "",
    "",
    ...(gate.context?.scope ? [`**Scope:** ${gate.context.scope}`, ""] : []),
    ...(gate.context?.criteria && gate.context.criteria.length > 0
      ? ["**Akzeptanzkriterien:**", ...gate.context.criteria.map((c) => `- ${c}`), ""]
      : []),
    ...(gate.context?.risks && gate.context.risks.length > 0
      ? ["**Risiken:**", ...gate.context.risks.map((r) => `- ${r}`), ""]
      : []),
    ...(gate.context?.nonGoals && gate.context.nonGoals.length > 0
      ? ["**Nicht-Ziele:**", ...gate.context.nonGoals.map((g) => `- ${g}`), ""]
      : []),
    ...(gate.context?.followUpAction ? [`**Folgeaktion:** ${gate.context.followUpAction}`, ""] : []),
    ...(publication.legacyContext.length > 0 ? ["### Kontext", ...publication.legacyContext.map((c) => `- ${c}`), ""] : []),
    "### Entscheidung",
    `Label \`${GATE_APPROVED_LABEL}\` hinzufügen zum Freigeben, oder \`${GATE_REJECTED_LABEL}\` zum Ablehnen. `,
    "Ein klärender Kommentar ist willkommen, zählt aber nicht als Entscheidung -- ausschließlich das Label.",
  ].join("\n");
  const issueSnapshot = await github.viewIssue(issue.repository, issue.number);
  if (!issueSnapshot.comments.some((existing) => existing.body.includes(publication.marker))) {
    await github.commentIssue(issue.repository, issue.number, comment);
  }

  return resolveGate(runState, gateId, {
    publication: { ...publication, status: "open" },
  });
}

export interface GateCheckResult {
  resolved: boolean;
  approved?: boolean;
  by?: string;
  at?: string;
  note?: string;
}

/**
 * Pure helper: filter label-timeline events to those on or after a cutoff
 * with a specific label name (TAC-05).
 */
export function filterValidLabelEvents(
  events: { label: string; actor: string; createdAt: string }[],
  labelName: string,
  openedAt: string,
): { label: string; actor: string; createdAt: string }[] {
  return events.filter((e) => e.label === labelName && e.createdAt >= openedAt);
}

export function selectCurrentGateDecision(
  events: { label: string; actor: string; createdAt: string }[],
  currentLabels: string[],
  openedAt: string,
): GateCheckResult {
  const active = new Set(currentLabels);
  const approvedEvents = active.has(GATE_APPROVED_LABEL)
    ? filterValidLabelEvents(events, GATE_APPROVED_LABEL, openedAt)
    : [];
  const rejectedEvents = active.has(GATE_REJECTED_LABEL)
    ? filterValidLabelEvents(events, GATE_REJECTED_LABEL, openedAt)
    : [];
  if (approvedEvents.length > 0 && rejectedEvents.length > 0) {
    throw new Error(
      `conflicting active approved and rejected labels since openedAt ${openedAt}; ` +
        "human intervention required to remove one of the labels",
    );
  }
  const event = approvedEvents.at(-1) ?? rejectedEvents.at(-1);
  if (!event) return { resolved: false };
  return {
    resolved: true,
    approved: event.label === GATE_APPROVED_LABEL,
    by: event.actor,
    at: event.createdAt,
  };
}

/**
 * Check whether the human gate has been decided by reading the label-timeline
 * events for the backing tracking issue. Only events on or after the gate's
 * `openedAt` timestamp are accepted (TAC-04/TAC-05). Simultaneous approved and
 * rejected events are treated as a blocking conflict (TAC-05).
 */
export async function checkHumanGateIssue(runState: RunState, gateId: string): Promise<GateCheckResult> {
  const gate = runState.gates.find((g) => g.id === gateId);
  if (!gate?.issue) {
    throw new Error(`gate '${gateId}' has no open GitHub issue yet; call openHumanGateIssue first`);
  }

  // TAC-04: read label-timeline events with actor and timestamp.
  const events = await github.listIssueLabelEvents(gate.issue.repository, gate.issue.number);
  const issue = await github.viewIssue(gate.issue.repository, gate.issue.number);

  // TAC-05: only events on or after openedAt are valid for this gate cycle.
  const openedAt = gate.openedAt ?? gate.createdAt;
  try {
    return selectCurrentGateDecision(events, issue.labels.map((label) => label.name), openedAt);
  } catch (error) {
    throw new Error(`gate '${gateId}' ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Pure state transition: compute the resolved gate state without any I/O.
 * Callers MUST persist this state before calling postGateDecision (TAC-06).
 */
export function computeGateDecision(runState: RunState, gateId: string, decision: GateCheckResult): RunState {
  if (!decision.resolved) {
    throw new Error(`cannot apply an unresolved decision for gate '${gateId}'`);
  }
  return resolveGate(runState, gateId, {
    result: decision.approved ? "passed" : "failed",
    decision: {
      approved: Boolean(decision.approved),
      by: decision.by ?? "unknown",
      at: decision.at ?? new Date().toISOString(),
      note: decision.note,
    },
    cleanupPending: true,
  });
}

/**
 * Idempotent side-effects after a gate has been decided and persisted:
 * post a confirmation comment and remove transient labels (TAC-07). This
 * intentionally runs *after* persistence so a cleanup failure cannot
 * undo a recorded decision (TAC-06/TAC-07).
 */
export async function postGateDecision(
  runState: RunState,
  gateId: string,
  decision: GateCheckResult,
): Promise<RunState> {
  const gate = runState.gates.find((g) => g.id === gateId);
  if (!gate?.issue || !gate.cleanupPending) return runState;

  const decisionAt = gate.decision?.at ?? decision.at ?? "unknown";
  const marker = `<!-- harness:gate-decision:${runState.runId}:${gateId}:${decisionAt} -->`;
  const issueSnapshot = await github.viewIssue(gate.issue.repository, gate.issue.number);
  if (!issueSnapshot.comments.some((existing) => existing.body.includes(marker))) {
    await github.commentIssue(
      gate.issue.repository,
      gate.issue.number,
      `${marker}\n${decision.approved
        ? `Harness: Gate \`${gateId}\` als **freigegeben** übernommen. Run \`${runState.runId}\` läuft weiter.`
        : `Harness: Gate \`${gateId}\` als **abgelehnt** übernommen. Run \`${runState.runId}\` pausiert.`}`,
    );
  }
  // Reset transient labels so the same tracking issue is clean for the
  // run's next gate cycle instead of accumulating stale decision labels.
  await github.removeLabels(gate.issue.repository, gate.issue.number, [
    GATE_LABEL,
    GATE_NEEDS_HUMAN_LABEL,
    GATE_APPROVED_LABEL,
    GATE_REJECTED_LABEL,
  ]);
  return resolveGate(runState, gateId, { cleanupPending: false });
}

/**
 * Convenience wrapper kept for backward compatibility: apply decision and
 * run side-effects. Callers that need guaranteed TAC-06 ordering (save
 * before cleanup) should use computeGateDecision + store.save + postGateDecision
 * directly instead.
 *
 * @deprecated Use computeGateDecision + store.save + postGateDecision instead.
 */
export async function applyGateDecision(
  runState: RunState,
  gateId: string,
  decision: GateCheckResult,
): Promise<RunState> {
  const next = computeGateDecision(runState, gateId, decision);
  // Note: caller is responsible for persisting `next` before postGateDecision.
  return postGateDecision(next, gateId, decision);
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
