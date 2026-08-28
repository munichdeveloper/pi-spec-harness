import { github } from "../github/gh.js";
import type { ReadinessWork } from "./readiness-coordinator.js";
import type { VerifiedSpikeEvidence } from "./readiness.js";

export interface ReadinessProducerPolicy {
  repository: string;
  workflowId: number;
  workflowPath: string;
  workflowRevision: string;
  allowedActorIds: number[];
}
type EvidenceApi = Pick<typeof github, "viewReadinessWorkflowRun" | "listReadinessResultArtifacts" | "downloadReadinessResult">;
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string" && item.trim().length > 0) && new Set(value).size === value.length;

function assertProducer(value: unknown, work: ReadinessWork, policy: ReadinessProducerPolicy, runId: number): Record<string, unknown> {
  const run = record(value);
  if (!run || run.id !== runId || run.workflow_id !== policy.workflowId || run.path !== policy.workflowPath
    || run.head_sha !== policy.workflowRevision || run.event !== "workflow_dispatch"
    || record(run.repository)?.full_name !== policy.repository || record(run.head_repository)?.full_name !== policy.repository
    || !policy.allowedActorIds.includes(Number(record(run.actor)?.id))
    || !policy.allowedActorIds.includes(Number(record(run.triggering_actor)?.id))
    || run.display_title !== `readiness:${work.key}`
    || !Number.isSafeInteger(run.run_attempt) || Number(run.run_attempt) < 1) {
    throw new Error("Untrusted readiness result producer");
  }
  return run;
}

/** Only verified workflow artifacts enter the readiness evaluator. Issue comments,
 * closure and a green workflow without criterion evidence are never sufficient.
 * Policy comes from trusted configuration, never from the result itself.
 */
export async function readVerifiedReadinessSpikeResult(work: ReadinessWork, policy: ReadinessProducerPolicy, api: EvidenceApi = github): Promise<VerifiedSpikeEvidence | undefined> {
  if (work.kind !== "spike" || !work.blockerId || !/^readiness-[a-f0-9]{64}$/.test(work.key)
    || !/^[a-f0-9]{40}$/.test(policy.workflowRevision) || !Number.isSafeInteger(policy.workflowId)
    || policy.workflowId <= 0 || !/^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/.test(policy.workflowPath)
    || !policy.allowedActorIds.length || !policy.allowedActorIds.every(id => Number.isSafeInteger(id) && id > 0)) {
    throw new Error("Invalid readiness result policy or work binding");
  }
  const receipt = work.receipt?.match(/^github-actions:(\d+)$/);
  if (!receipt || !Number.isSafeInteger(Number(receipt[1])) || Number(receipt[1]) <= 0) throw new Error("Invalid readiness dispatch receipt");
  const runId = Number(receipt[1]);
  const run = assertProducer(await api.viewReadinessWorkflowRun(policy.repository, runId), work, policy, runId);
  if (run.status !== "completed") return undefined;
  if (run.conclusion !== "success") throw new Error("Readiness workflow failed; result cannot be accepted");
  const artifactName = `readiness-result-${work.key.slice("readiness-".length)}-${run.run_attempt}`;
  const matches = (await api.listReadinessResultArtifacts(policy.repository, runId)).map(record).filter(artifact => artifact?.name === artifactName);
  if (matches.length !== 1) throw new Error("Missing or ambiguous readiness result artifact");
  const artifact = matches[0]!;
  if (artifact.expired !== false || !Number.isSafeInteger(artifact.id) || Number(artifact.id) <= 0
    || record(artifact.workflow_run)?.id !== runId || record(artifact.workflow_run)?.head_sha !== policy.workflowRevision
    || !Number.isSafeInteger(artifact.size_in_bytes) || Number(artifact.size_in_bytes) <= 0 || Number(artifact.size_in_bytes) > 262144) {
    throw new Error("Invalid readiness result artifact provenance");
  }
  const result = record(await api.downloadReadinessResult(policy.repository, runId, artifactName));
  const after = assertProducer(await api.viewReadinessWorkflowRun(policy.repository, runId), work, policy, runId);
  if (after.run_attempt !== run.run_attempt || after.status !== "completed" || after.conclusion !== "success") {
    throw new Error("Readiness producer changed during verification");
  }
  if (!result || result.schemaVersion !== 1 || result.workKey !== work.key || result.attempt !== work.attempt
    || result.executorId !== work.executorId || result.issue !== work.issue || !Number.isSafeInteger(work.issue)
    || result.runId !== runId || result.runAttempt !== run.run_attempt
    || result.blockerId !== work.blockerId || result.specRevision !== work.revision
    || !["passed", "failed"].includes(String(result.verdict)) || !strings(result.verifiedCriteria)
    || !strings(result.references) || !result.references.length || !strings(result.changes)
    || !result.changes.every(change => ["scope", "cost", "privacy"].includes(change))) {
    throw new Error("Invalid or incorrectly bound readiness result");
  }
  return { blockerId: work.blockerId, specRevision: work.revision, verdict: result.verdict as "passed" | "failed",
    verifiedCriteria: result.verifiedCriteria, references: [...result.references, `https://github.com/${policy.repository}/actions/runs/${runId}/attempts/${run.run_attempt}`],
    changes: result.changes as VerifiedSpikeEvidence["changes"] };
}
