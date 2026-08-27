import { readFile } from "node:fs/promises";
import { github } from "../github/gh.js";
import { IssueStateStore } from "../state/issue-store.js";
import { formatCanonicalRunId } from "../state/state-machine.js";
import { executeReadinessWork, type ReadinessCommand } from "./readiness-executor.js";
import { isReadinessContract, type ExecutorPolicy } from "./readiness.js";
import type { ReadinessWork } from "./readiness-coordinator.js";
import type { StateStore } from "../state/state-store.js";

export interface ReadinessExecutionConfig {
  schemaVersion: 1;
  repository: string;
  costCeiling: number;
  policy: ExecutorPolicy;
  contract: unknown;
  agent: ReadinessCommand;
  verifier?: ReadinessCommand;
  audit: { directory: string; branch: string };
}

export function commandValid(value: unknown): value is ReadinessCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<ReadinessCommand>;
  return typeof c.executable === "string" && !!c.executable.trim() && typeof c.cwd === "string" && !!c.cwd.trim()
    && Array.isArray(c.args) && c.args.every(arg => typeof arg === "string")
    && Number.isSafeInteger(c.timeoutMs) && c.timeoutMs! > 0 && c.timeoutMs! <= 3600000
    && !!c.env && typeof c.env === "object" && !Array.isArray(c.env) && Object.values(c.env).every(v => typeof v === "string");
}

export function parseReadinessExecutionConfig(value: unknown): ReadinessExecutionConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid readiness execution configuration");
  const c = value as Partial<ReadinessExecutionConfig>;
  const p = c.policy;
  if (c.schemaVersion !== 1 || typeof c.repository !== "string" || !/^[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*$/.test(c.repository)
    || !Number.isFinite(c.costCeiling) || c.costCeiling! < 0 || !p || typeof p.id !== "string" || !p.id.trim()
    || typeof p.authorized !== "boolean" || typeof p.available !== "boolean"
    || !Array.isArray(p.capabilities) || !p.capabilities.every(cap => ["spike", "implementation"].includes(cap))
    || !Number.isFinite(p.maxTaskCost) || p.maxTaskCost < 0 || !isReadinessContract(c.contract)
    || !commandValid(c.agent) || (c.verifier !== undefined && !commandValid(c.verifier))
    || !c.audit || typeof c.audit.directory !== "string" || !/^docs\/[\w/-]+$/.test(c.audit.directory)
    || typeof c.audit.branch !== "string" || !c.audit.branch.trim()) throw new Error("Invalid readiness execution configuration");
  return c as ReadinessExecutionConfig;
}

/** Config is executable authority, not task data: use a trusted checkout only.
 * Workflow callers must pin/verify that checkout before invoking this command.
 * The CLI never reads commands from issues, PR branches or agent output.
 */
export async function runReadinessExecuteCommand(options: {
  repository: string; runIssue: number; workKey: string; receipt: string; configPath: string;
}, dependencies?: { store: StateStore; confirmAudit: (work: ReadinessWork) => Promise<void> }) {
  if (!dependencies && (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== options.repository
    || options.receipt !== `github-actions:${process.env.GITHUB_RUN_ID}`)) {
    throw new Error("Readiness execution requires the bound GitHub Actions runtime");
  }
  if (!Number.isSafeInteger(options.runIssue) || options.runIssue < 1) throw new Error("Invalid canonical run issue");
  const config = parseReadinessExecutionConfig(JSON.parse(await readFile(options.configPath, "utf8")) as unknown);
  if (config.repository !== options.repository) throw new Error("Executor configuration repository mismatch");
  const store = dependencies?.store ?? new IssueStateStore(options.repository, options.runIssue);
  const state = await store.load();
  if (state.repository !== options.repository || !state.readiness || !isReadinessContract(config.contract)
    || config.contract.specRevision !== state.readiness.revision) throw new Error("Executor configuration does not match canonical readiness revision");
  const work = state.readiness.work.find(item => item.key === options.workKey);
  if (!work) throw new Error("No canonical readiness work matches request");
  const confirmAudit = dependencies?.confirmAudit ?? (async (current: ReadinessWork) => {
    const execution = current.execution!;
    const id = `${current.key}:execution:${execution.status}`;
    await github.dispatchProcessAuditEnvelopeV1(options.repository, {
      schema_version: 1, occurred_at: execution.finishedAt ?? execution.startedAt,
      process_instance: formatCanonicalRunId(options.repository, options.runIssue).processInstance,
      idempotency_key: id, process_code: "PROCESS_RECONCILIATION", actor: "GITHUB_ACTIONS",
      access_role: "GITHUB_ACTIONS_TOKEN", supporting_access_roles: [],
      outcome: execution.status === "failed" ? "FAILED" : "SUCCEEDED", repository: options.repository,
      artifact: current.revision, correlation_ids: [`ISSUE-${options.runIssue}`, current.key],
      evidence: [`https://github.com/${options.repository}/issues/${options.runIssue}`],
      reason: `Readiness execution ${execution.status}`,
      description: `Executor ${current.executorId}; ${current.kind}; attempt ${current.attempt}; receipt ${execution.receipt}. Next responsibility: readiness reconciliation.`,
    });
    await github.confirmAuditEventInJournal(options.repository, config.audit.directory, id, config.audit.branch);
  });
  const output = await executeReadinessWork({ store, workKey: options.workKey, receipt: options.receipt,
    policy: config.policy, costCeiling: config.costCeiling,
    blocker: config.contract.blockers.find(blocker => blocker.id === work.blockerId),
    agent: config.agent, verifier: config.verifier, confirmAudit });
  const artifact = work.kind === "spike" ? {
    ...(output as Record<string, unknown>), schemaVersion: 1, workKey: work.key,
    executorId: work.executorId, issue: work.issue, attempt: work.attempt,
    blockerId: work.blockerId, specRevision: work.revision,
    runId: Number(options.receipt.slice("github-actions:".length)),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? "1"),
  } : undefined;
  return { schemaVersion: 1, command: "readiness-execute", result: { workKey: options.workKey, output, artifact },
    nextAction: "Publish the bound result artifact and reconcile the same canonical run." };
}
