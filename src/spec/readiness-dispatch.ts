import { github } from "../github/gh.js";
import type { ReadinessProducerPolicy } from "./readiness-evidence.js";
import type { ReadinessWork } from "./readiness-coordinator.js";

export interface ReadinessDispatchPolicy extends ReadinessProducerPolicy {
  /** Branch checked immediately before dispatch; receiver validates immutable SHA. */
  branch: string;
}
type DispatchApi = Pick<typeof github, "listReadinessWorkflowRuns" | "viewReadinessWorkflowRun" | "getBranchSha" | "dispatchReadinessWorkflow">;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

function trustedRun(v: unknown, workKey: string, policy: ReadinessDispatchPolicy): boolean {
  const run = object(v);
  return Number.isSafeInteger(run.id) && Number(run.id) > 0 && run.workflow_id === policy.workflowId
    && run.path === policy.workflowPath && run.head_sha === policy.workflowRevision
    && run.event === "workflow_dispatch" && run.display_title === `readiness:${workKey}`
    && object(run.repository).full_name === policy.repository && object(run.head_repository).full_name === policy.repository
    && policy.allowedActorIds.includes(Number(object(run.actor).id))
    && policy.allowedActorIds.includes(Number(object(run.triggering_actor).id));
}

export async function findReadinessDispatch(work: Pick<ReadinessWork, "key" | "receipt">, policy: ReadinessDispatchPolicy, api: DispatchApi = github): Promise<string | undefined> {
  if (work.receipt) {
    const match = work.receipt.match(/^github-actions:([1-9]\d*)$/);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("Invalid canonical readiness receipt");
    const run = await api.viewReadinessWorkflowRun(policy.repository, Number(match[1]));
    if (object(run).id !== Number(match[1]) || !trustedRun(run, work.key, policy)) {
      throw new Error("Canonical readiness receipt does not match trusted workflow");
    }
    return work.receipt;
  }
  const candidates = (await api.listReadinessWorkflowRuns(policy.repository, policy.workflowId))
    .filter(run => trustedRun(run, work.key, policy)).map(object).sort((a, b) => Number(a.id) - Number(b.id));
  // All receivers share the repository/spec lock and must claim the canonical
  // receipt. Extra transport runs cannot claim or execute this work again.
  return candidates.length ? `github-actions:${candidates[0].id}` : undefined;
}

export async function dispatchReadinessWork(input: {
  work: ReadinessWork; runIssue: number; policy: ReadinessDispatchPolicy;
}, api: DispatchApi = github, wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 2000))): Promise<string> {
  const { work, policy, runIssue } = input;
  if (!Number.isSafeInteger(runIssue) || runIssue <= 0 || !/^readiness-[a-f0-9]{64}$/.test(work.key)
    || !/^[a-f0-9]{40}$/.test(work.revision) || !/^[a-f0-9]{40}$/.test(policy.workflowRevision)
    || !Number.isSafeInteger(policy.workflowId) || policy.workflowId <= 0
    || !policy.allowedActorIds.length || !policy.allowedActorIds.every(id => Number.isSafeInteger(id) && id > 0)) {
    throw new Error("Invalid readiness dispatch policy");
  }
  const existing = await findReadinessDispatch(work, policy, api);
  if (existing) return existing;
  if (await api.getBranchSha(policy.repository, policy.branch) !== policy.workflowRevision) {
    throw new Error("Readiness workflow branch moved; refresh trusted policy before dispatch");
  }
  let dispatchFailed = false;
  try {
    await api.dispatchReadinessWorkflow(policy.repository, policy.workflowId, policy.branch, {
      "run-issue": String(runIssue), "work-key": work.key, "spec-revision": work.revision,
      "workflow-revision": policy.workflowRevision,
    });
  } catch { dispatchFailed = true; }
  // GitHub returns no run ID from workflow_dispatch. Resolve the actual receipt,
  // including an accepted request whose HTTP response was lost. Never claim a
  // fabricated receipt or issue a second POST during this attempt.
  for (let attempt = 0; attempt < 5; attempt++) {
    const receipt = await findReadinessDispatch(work, policy, api);
    if (receipt) return receipt;
    if (attempt < 4) await wait();
  }
  throw new Error(dispatchFailed ? "Readiness dispatch outcome uncertain; reconcile before retry" : "Readiness dispatch accepted but run not yet visible; reconcile later");
}
