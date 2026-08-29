import { github } from "../github/gh.js";
import type { StateStore } from "../state/state-store.js";

export type SyntheticReadinessOutcome = "positive-proof" | "negative-proof" | "blocked-evidence";

type LifecycleApi = Pick<typeof github, "listReadinessIssues" | "closeIssue">;

function validUrl(value: string): boolean {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

/**
 * Retires only synthetic readiness child issues while retaining the canonical
 * tracking issue, state and all execution evidence. It never advances a product
 * lifecycle phase and never marks an implementation subprocess as delivery.
 */
export async function disposeSyntheticReadinessEvidence(
  store: StateStore,
  input: { outcome: SyntheticReadinessOutcome; reason: string; evidence: string[]; occurredAt: string },
  api: LifecycleApi = github,
) {
  const state = await store.load();
  if (!/^SPEC-9\d{5}$/.test(state.spec) || !state.runId.startsWith("readiness-spec-9") || !state.readiness) {
    throw new Error("Lifecycle disposition is restricted to synthetic readiness runs");
  }
  if (state.phase === "complete") throw new Error("Completed runs cannot be disposed as synthetic evidence");
  if (!input.reason.trim() || !input.evidence.length || !input.evidence.every(validUrl)
    || new Date(input.occurredAt).toISOString() !== input.occurredAt) {
    throw new Error("Invalid synthetic lifecycle disposition evidence");
  }
  if (state.readiness.work.some(work => work.execution?.status === "claimed")) {
    throw new Error("Cannot dispose a run with claimed work");
  }

  const childIssues = [...new Set([
    ...(state.issue ? [state.issue] : []),
    ...state.readiness.work.flatMap(work => work.issue ? [work.issue] : []),
  ])].sort((a, b) => a - b);
  const existing = state.readiness.lifecycleDisposition;
  if (existing) {
    if (existing.outcome !== input.outcome || existing.reason !== input.reason
      || JSON.stringify(existing.evidence) !== JSON.stringify(input.evidence)
      || existing.occurredAt !== input.occurredAt) throw new Error("Conflicting lifecycle disposition");
  } else {
    state.readiness.lifecycleDisposition = {
      schemaVersion: 1, status: "prepared", outcome: input.outcome, reason: input.reason,
      evidence: [...input.evidence], occurredAt: input.occurredAt, childIssues, closedIssues: [],
    };
    await store.save(state);
  }

  const disposition = state.readiness.lifecycleDisposition!;
  const issues = await api.listReadinessIssues(state.repository);
  for (const issueNumber of disposition.childIssues) {
    if (disposition.closedIssues.includes(issueNumber)) continue;
    const issue = issues.find(candidate => candidate.number === issueNumber);
    if (!issue) throw new Error(`Synthetic child issue #${issueNumber} is missing`);
    if (issue.state.toLowerCase() === "open") {
      await api.closeIssue(state.repository, issueNumber,
        `Synthetic readiness evidence retained on the canonical run. Disposition: ${disposition.outcome}. This does not complete a product lifecycle.`);
    }
    disposition.closedIssues.push(issueNumber);
    disposition.closedIssues.sort((a, b) => a - b);
    await store.save(state);
  }
  disposition.status = "disposed";
  await store.save(state);
  return { disposition, phase: state.phase, trackingIssueRetained: true };
}
