import { createHash } from "node:crypto";
import { github } from "../github/gh.js";
import { IssueStateStore } from "../state/issue-store.js";
import { formatCanonicalRunId } from "../state/state-machine.js";
import { buildIssueFromSpec, parseSpecFrontmatterForIssue } from "./issue-from-spec.js";
import { ensureReadinessRun } from "./readiness-run.js";
import { ensureReadinessImplementationIssue, ensureReadinessSpikeIssue } from "./readiness-issues.js";
import { reconcileReadiness } from "./readiness-coordinator.js";
import { dispatchReadinessWork, findReadinessDispatch, type ReadinessDispatchPolicy } from "./readiness-dispatch.js";
import { readVerifiedReadinessSpikeResult } from "./readiness-evidence.js";
import { isReadinessContract, type ExecutorPolicy, type ReadinessAction, type ReadinessDecision } from "./readiness.js";
import { recoverReadinessTransport } from "./readiness-recovery.js";

const labels: Record<ReadinessAction, string> = {
  "await-approval": "harness:readiness-approval", classify: "harness:readiness-classify",
  "human-decision": "harness:readiness-human", spike: "harness:readiness-spike",
  "await-executor": "harness:readiness-executor", implement: "harness:readiness-ready",
};

/** Concrete GitHub controller. Its caller supplies trusted configuration and
 * serializes the entire call with receivers under the same repository/spec lock.
 * Readiness labels are deliberately separate from legacy Copilot triggers.
 */
export async function runReadinessHandoff(input: {
  repository: string; branch: string; specPath: string; revision: string;
  contract: unknown; costCeiling: number;
  workflows: Record<string, ReadinessDispatchPolicy>;
  currentExecutors: () => Promise<ExecutorPolicy[]>;
  audit: { directory: string; branch: string; actor: string; accessRole: string };
}) {
  if (!/^[a-f0-9]{40}$/.test(input.revision)) throw new Error("Readiness handoff requires immutable source revision");
  if (await github.getBranchSha(input.repository, input.branch) !== input.revision) {
    throw new Error("Readiness source revision no longer matches trusted branch");
  }
  const { content, blobSha: specRevision } = await github.getFileContent(input.repository, input.specPath, input.revision);
  if (!/^[a-f0-9]{40}$/.test(specRevision)) throw new Error("Invalid immutable spec content identity");
  const frontmatter = parseSpecFrontmatterForIssue(content);
  if (frontmatter.status !== "approved") return { action: "await-approval", reason: "spec-not-approved" };
  const built = buildIssueFromSpec(content, { specPath: input.specPath });
  if (frontmatter.requirements.length !== 1) throw new Error("Readiness run requires an explicit single requirement binding");
  const canonical = await ensureReadinessRun({ repository: input.repository, specId: frontmatter.id,
    requirementId: frontmatter.requirements[0], specPath: input.specPath, approvedRevision: specRevision,
    approvalEvidence: `https://github.com/${input.repository}/blob/${input.revision}/${input.specPath}` });
  const backingStore = new IssueStateStore(input.repository, canonical.issue.number, canonical.issue.url);
  const store = {
    load: () => backingStore.load(),
    save: async (state: Awaited<ReturnType<IssueStateStore["load"]>>) => {
      // Audit callbacks checkpoint independently while the coordinator holds its
      // loaded state. Preserve those records under the shared concurrency lock.
      const latest = await backingStore.load();
      state.readinessAudits = { ...state.readinessAudits, ...latest.readinessAudits };
      await backingStore.save(state);
    },
  };
  const audit = async (identity: string, description: string, evidence: string[] = []) => {
    const id = `readiness:${createHash("sha256").update(`${canonical.issue.number}:${identity}`).digest("hex")}`;
    const state = await backingStore.load();
    state.readinessAudits ??= {};
    if (!state.readinessAudits[id]) {
      state.readinessAudits[id] = { occurredAt: new Date().toISOString(), revision: input.revision, description, evidence: [canonical.issue.url, ...evidence] };
      await backingStore.save(state);
    }
    const event = state.readinessAudits[id];
    await github.dispatchProcessAuditEnvelopeV1(input.repository, {
      schema_version: 1, occurred_at: event.occurredAt,
      process_instance: formatCanonicalRunId(input.repository, canonical.issue.number).processInstance,
      idempotency_key: id, process_code: "PROCESS_RECONCILIATION", actor: input.audit.actor,
      access_role: input.audit.accessRole, supporting_access_roles: [], outcome: "SUCCEEDED",
      repository: input.repository, artifact: event.revision, correlation_ids: [`ISSUE-${canonical.issue.number}`, frontmatter.id],
      evidence: event.evidence, reason: "Reconcile approved spec readiness on its canonical run", description: event.description,
    });
    await github.confirmAuditEventInJournal(input.repository, input.audit.directory, id, input.audit.branch);
  };
  await audit("canonical-run", "Canonical run established or recovered; next actor: readiness controller.");
  const workflow = (executorId: string) => {
    if (!Object.hasOwn(input.workflows, executorId)) throw new Error("No trusted workflow for selected executor");
    const policy = input.workflows[executorId];
    if (policy.repository !== input.repository) throw new Error("Cross-repository readiness execution is not configured");
    return policy;
  };
  const setLabels = async (issue: number, decision: ReadinessDecision) => {
    const desired = labels[decision.action];
    await github.ensureLabel(input.repository, desired, { color: "1D76DB", description: `Harness readiness: ${decision.action}` });
    const current = await github.viewIssue(input.repository, issue);
    await github.addLabels(input.repository, issue, current.labels.some(label => label.name === desired) ? [] : [desired]);
    await github.removeLabels(input.repository, issue, current.labels.map(label => label.name).filter(name => Object.values(labels).includes(name) && name !== desired));
    await audit(`decision:${JSON.stringify(decision)}`, `Readiness ${decision.action}: ${decision.reason}; next executor ${decision.executorId ?? "none"}.`);
  };
  const beforeRecovery = await store.load();
  const recovery = beforeRecovery.readiness?.revision === specRevision
    ? await recoverReadinessTransport({ store, workflow, currentExecutors: input.currentExecutors, costCeiling: input.costCeiling, audit }) : undefined;
  if (recovery) {
    const state = await store.load();
    if (recovery.action !== "observe-work" && state.issue) await setLabels(state.issue, recovery);
    return { ...recovery, runIssue: canonical.issue.number, runUrl: canonical.issue.url };
  }
  const result = await reconcileReadiness(store, { specId: frontmatter.id, approved: true, revision: specRevision,
    contract: input.contract, costCeiling: input.costCeiling }, {
    ensureImplementationIssue: async key => {
      const number = await ensureReadinessImplementationIssue(input.repository, { key, specId: frontmatter.id, title: frontmatter.title, body: built.body });
      await audit(`issue:${key}`, `Implementation issue #${number} established or recovered; next actor: readiness controller.`);
      return number;
    },
    ensureSpikeIssue: async work => {
      if (!isReadinessContract(input.contract)) throw new Error("Cannot create spike without validated contract");
      const blocker = input.contract.blockers.find(item => item.id === work.blockerId);
      const state = await store.load();
      if (!blocker || !state.issue) throw new Error("Spike has no canonical blocker/implementation binding");
      const number = await ensureReadinessSpikeIssue(input.repository, { work, blocker, specId: frontmatter.id, implementationIssue: state.issue });
      await audit(`spike:${work.key}`, `Spike #${number} established; owner ${blocker.owner}; executor ${work.executorId}.`);
      return number;
    },
    reconcileReadinessLabels: setLabels,
    currentExecutors: input.currentExecutors,
    findReadinessWork: async key => {
      const state = await store.load();
      const work = state.readiness?.work.find(item => item.key === key);
      if (!work) throw new Error("Dispatch intent missing from canonical run");
      return findReadinessDispatch(work, workflow(work.executorId));
    },
    dispatchReadinessWork: work => dispatchReadinessWork({ work, runIssue: canonical.issue.number, policy: workflow(work.executorId) }),
    confirmReadinessAudit: work => audit(`dispatch:${work.key}`, `Work ${work.key} dispatched to ${work.executorId}; receipt ${work.receipt}; next actor: executor.`),
    confirmSpikeResultAudit: (work, evidence) => audit(`result:${work.key}`, `Verified spike ${work.blockerId}: ${evidence.verdict}; next actor: readiness controller.`, evidence.references),
    readVerifiedSpikeResult: work => readVerifiedReadinessSpikeResult(work, workflow(work.executorId)),
  });
  return { ...result, runIssue: canonical.issue.number, runUrl: canonical.issue.url };
}
