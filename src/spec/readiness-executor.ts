import { spawn } from "node:child_process";
import { assertHygiene } from "../state/hygiene.js";
import type { StateStore } from "../state/state-store.js";
import type { ExecutorPolicy, ReadinessBlocker, VerifiedSpikeEvidence } from "./readiness.js";
import type { ReadinessWork } from "./readiness-coordinator.js";

export interface ReadinessCommand {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Explicit environment, never copied into canonical state. */
  env: Record<string, string>;
}

/** Commands come only from pinned trusted executor configuration. Payloads are
 * passed as JSON on stdin, never interpolated into shell commands. No shell,
 * implicit environment inheritance, raw stderr logging or unlimited output.
 */
export async function runReadinessCommand(command: ReadinessCommand, input: unknown): Promise<unknown> {
  if (!command.executable || !command.cwd || !Array.isArray(command.args)
    || !command.args.every(arg => typeof arg === "string") || !Number.isSafeInteger(command.timeoutMs)
    || command.timeoutMs < 1 || command.timeoutMs > 3600000) throw new Error("Invalid trusted readiness command");
  const payload = JSON.stringify(input);
  if (Buffer.byteLength(payload) > 262144) throw new Error("Readiness command input too large");
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd, env: command.env, shell: false, windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const stop = (message: string) => { failure ??= new Error(message); child.kill(); };
    const timer = setTimeout(() => stop("Readiness command timed out; execution requires reconciliation"), command.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 262144) stop("Readiness command output limit exceeded");
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => stop("Readiness command rejected its input"));
    child.on("error", () => { clearTimeout(timer); reject(new Error("Readiness command could not start")); });
    child.on("close", code => {
      clearTimeout(timer);
      if (failure || code !== 0) { reject(failure ?? new Error("Readiness command failed")); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown); }
      catch { reject(new Error("Readiness command returned invalid JSON")); }
    });
    child.stdin.end(payload);
  });
}

function verifiedResult(value: unknown, work: ReadinessWork, blocker: ReadinessBlocker): VerifiedSpikeEvidence {
  const result = value as Partial<VerifiedSpikeEvidence> | null;
  const list = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === "string" && x.trim().length > 0) && new Set(v).size === v.length;
  if (!result || result.blockerId !== blocker.id || result.specRevision !== work.revision
    || !["passed", "failed"].includes(String(result.verdict)) || !list(result.verifiedCriteria)
    || !list(result.references) || !result.references.length || !list(result.changes)
    || !result.changes.every(change => ["scope", "cost", "privacy"].includes(change))
    || (result.verdict === "passed" && !blocker.criteria.every(c => result.verifiedCriteria!.includes(c)))) {
    throw new Error("Independent spike verifier returned invalid or incomplete evidence");
  }
  const evidence: VerifiedSpikeEvidence = { blockerId: blocker.id, specRevision: work.revision,
    verdict: result.verdict as "passed" | "failed", verifiedCriteria: result.verifiedCriteria,
    references: result.references, changes: result.changes };
  assertHygiene(evidence);
  return evidence;
}

/** Receiver runs under the same per-spec concurrency lock as reconciliation.
 * Persist the claim before launching an agent. An interrupted claim cannot be
 * blindly retried: the external side effect might already have happened.
 */
export async function executeReadinessWork(input: {
  store: StateStore;
  workKey: string;
  receipt: string;
  policy: ExecutorPolicy;
  costCeiling: number;
  blocker?: ReadinessBlocker;
  agent: ReadinessCommand;
  verifier?: ReadinessCommand;
  confirmAudit: (work: ReadinessWork) => Promise<void>;
}): Promise<unknown> {
  const state = await input.store.load();
  const matches = state.readiness?.work.filter(work => work.key === input.workKey) ?? [];
  if (matches.length !== 1) throw new Error("Readiness work is not uniquely bound to canonical run");
  const work = matches[0];
  if (!input.receipt.trim() || (work.receipt && work.receipt !== input.receipt)) throw new Error("Readiness receiver receipt mismatch");
  if (work.execution) {
    if (work.execution.receipt !== input.receipt) throw new Error("Readiness work already claimed by another execution");
    if (work.execution.status !== "completed") throw new Error("Previous readiness execution requires reconciliation; refusing duplicate");
    await input.confirmAudit(work);
    return work.execution.output;
  }
  const p = input.policy;
  if (p.id !== work.executorId || p.authorized !== true || p.available !== true || !p.capabilities.includes(work.kind)
    || !Number.isFinite(p.maxTaskCost) || p.maxTaskCost < 0 || !Number.isFinite(input.costCeiling)
    || input.costCeiling < p.maxTaskCost) throw new Error("Readiness executor is unavailable or unauthorized");
  if (work.kind === "spike" && (!input.verifier || !input.blocker || input.blocker.id !== work.blockerId
    || input.blocker.kind !== "technical" || input.blocker.stage !== "implementation"
    || work.attempt < 1 || work.attempt > input.blocker.maxAttempts)) throw new Error("Missing trusted spike verifier or blocker binding");
  const save = async () => { assertHygiene(state); await input.store.save(state); };
  work.receipt = input.receipt;
  work.execution = { receipt: input.receipt, status: "claimed", startedAt: new Date().toISOString() };
  await save();
  await input.confirmAudit(work);
  try {
    const task = { schemaVersion: 1, workKey: work.key, kind: work.kind, issue: work.issue,
      specRevision: work.revision, attempt: work.attempt, blocker: input.blocker };
    const candidate = await runReadinessCommand(input.agent, task);
    const output = work.kind === "spike"
      ? verifiedResult(await runReadinessCommand(input.verifier!, { ...task, candidate }), work, input.blocker!)
      : candidate;
    assertHygiene(output);
    work.execution.output = output;
    work.execution.status = "completed";
    work.execution.finishedAt = new Date().toISOString();
    await save();
  } catch {
    // Do not persist provider output or error messages, which may contain credentials.
    delete work.execution.output;
    work.execution.status = "failed";
    work.execution.finishedAt = new Date().toISOString();
    await save();
    await input.confirmAudit(work);
    throw new Error("Readiness execution failed; inspect bounded provider/verifier diagnostics");
  }
  await input.confirmAudit(work);
  return work.execution.output;
}
