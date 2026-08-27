import { readFile } from "node:fs/promises";
import { commandValid } from "./readiness-execute-command.js";
import { runReadinessCommand, type ReadinessCommand } from "./readiness-executor.js";
import { runReadinessHandoff } from "./readiness-handoff.js";
import type { ExecutorPolicy } from "./readiness.js";
import type { ReadinessDispatchPolicy } from "./readiness-dispatch.js";

export interface ReadinessReconcileConfig {
  schemaVersion: 1;
  repository: string;
  branch: string;
  specPath: string;
  contract: unknown;
  costCeiling: number;
  executors: Array<{ policy: Omit<ExecutorPolicy, "available">; availability: ReadinessCommand; workflow: ReadinessDispatchPolicy }>;
  audit: { directory: string; branch: string };
}

export function parseReadinessReconcileConfig(value: unknown): ReadinessReconcileConfig {
  const c = value as Partial<ReadinessReconcileConfig> | null;
  if (!c || c.schemaVersion !== 1 || typeof c.repository !== "string" || !/^[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*$/.test(c.repository)
    || typeof c.branch !== "string" || !c.branch.trim() || typeof c.specPath !== "string"
    || !/^docs\/[a-zA-Z0-9_./-]+\.md$/.test(c.specPath) || c.specPath.split("/").includes("..")
    || !Number.isFinite(c.costCeiling) || c.costCeiling! < 0 || !Array.isArray(c.executors)
    || !c.audit || typeof c.audit.directory !== "string" || !/^docs\/[\w/-]+$/.test(c.audit.directory)
    || typeof c.audit.branch !== "string" || !c.audit.branch.trim()) throw new Error("Invalid readiness reconciliation configuration");
  const ids = new Set<string>();
  for (const executor of c.executors) {
    const p = executor?.policy; const w = executor?.workflow;
    if (!p || typeof p.id !== "string" || !p.id.trim() || ids.has(p.id) || typeof p.authorized !== "boolean"
      || !Array.isArray(p.capabilities) || !p.capabilities.every(cap => ["spike", "implementation"].includes(cap))
      || !Number.isFinite(p.maxTaskCost) || p.maxTaskCost < 0 || !commandValid(executor.availability)
      || !w || w.repository !== c.repository || typeof w.branch !== "string" || !w.branch.trim()
      || !Number.isSafeInteger(w.workflowId) || w.workflowId <= 0 || !/^[a-f0-9]{40}$/.test(w.workflowRevision)
      || !/^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/.test(w.workflowPath)
      || !Array.isArray(w.allowedActorIds) || !w.allowedActorIds.length || !w.allowedActorIds.every(id => Number.isSafeInteger(id) && id > 0)) {
      throw new Error("Invalid or ambiguous readiness executor configuration");
    }
    ids.add(p.id);
  }
  return c as ReadinessReconcileConfig;
}

export async function probeReadinessExecutors(config: ReadinessReconcileConfig): Promise<ExecutorPolicy[]> {
  return Promise.all(config.executors.map(async executor => {
    let available = false;
    // Do not even probe providers outside the approved execution/cost scope.
    if (executor.policy.authorized && executor.policy.maxTaskCost <= config.costCeiling) {
      try {
        const result = await runReadinessCommand(executor.availability, { schemaVersion: 1, executorId: executor.policy.id, operation: "availability" });
        available = !!result && typeof result === "object" && (result as { available?: unknown }).available === true;
      } catch { /* Missing quota/probe failure never implies permission or availability. */ }
    }
    return { ...executor.policy, available };
  }));
}

export async function runReadinessReconcileCommand(options: { repository: string; revision: string; configPath: string }) {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== options.repository) {
    throw new Error("Readiness reconciliation requires a trusted GitHub Actions runtime");
  }
  const config = parseReadinessReconcileConfig(JSON.parse(await readFile(options.configPath, "utf8")) as unknown);
  if (config.repository !== options.repository) throw new Error("Readiness configuration repository mismatch");
  const result = await runReadinessHandoff({ ...config, revision: options.revision,
    workflows: Object.fromEntries(config.executors.map(executor => [executor.policy.id, executor.workflow])),
    currentExecutors: () => probeReadinessExecutors(config),
    audit: { ...config.audit, actor: "GITHUB_ACTIONS", accessRole: "GITHUB_ACTIONS_TOKEN" } });
  return { schemaVersion: 1, command: "readiness-reconcile", result, nextAction: result.reason };
}
