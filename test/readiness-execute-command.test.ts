import { describe, expect, it, vi } from "vitest";
import { parseReadinessExecutionConfig, runReadinessExecuteCommand } from "../src/spec/readiness-execute-command.js";
import { initRunState } from "../src/state/state-machine.js";
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>(), readFile: vi.fn() }));
import { readFile } from "node:fs/promises";

function config() {
  return { schemaVersion: 1, repository: "acme/product", costCeiling: 0,
    policy: { id: "synthetic", available: true, authorized: true, capabilities: ["implementation"], maxTaskCost: 0 },
    contract: { schemaVersion: 1, specRevision: "revision", blockers: [] },
    agent: { executable: process.execPath, args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({synthetic:true})))"], cwd: process.cwd(), timeoutMs: 5000, env: {} },
    availability: { executable: process.execPath, args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({available:true})))"], cwd: process.cwd(), timeoutMs: 5000, env: {} },
    audit: { directory: "docs/process-audit/journal", branch: "main" } };
}
describe("SPEC-016 executable CLI entry point", () => {
  it("executes bound synthetic work and returns the standard CLI envelope", async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(config()));
    let state = initRunState({ repository: "acme/product", runId: "test", requirement: "REQ-001", spec: "SPEC-001" });
    state.readiness = { schemaVersion: 1, revision: "revision", implementationKey: "issue", work: [{ key: "work", revision: "revision", kind: "implementation", executorId: "synthetic", attempt: 1, issue: 96 }] };
    const store = { load: async () => structuredClone(state), save: async (next: typeof state) => { state = structuredClone(next); } };
    const confirmAudit = vi.fn(async () => {});
    const output = await runReadinessExecuteCommand({ repository: "acme/product", runIssue: 97, workKey: "work", receipt: "github-actions:123", configPath: "trusted.json" }, { store, confirmAudit });
    expect(output).toMatchObject({ schemaVersion: 1, command: "readiness-execute", result: { output: { synthetic: true } } });
    expect(confirmAudit).toHaveBeenCalledTimes(2);
    expect(state.readiness?.work[0].execution?.status).toBe("completed");
  });
  it("validates configuration before executing any command", () => {
    for (const patch of [{ costCeiling: -1 }, { repository: "../unsafe" }, { agent: { ...config().agent, timeoutMs: 0 } }, { contract: {} }]) {
      expect(() => parseReadinessExecutionConfig({ ...config(), ...patch })).toThrow("Invalid");
    }
  });
  it("defers and audits a lost quota before claiming or starting the agent", async () => {
    const c = config(); c.availability.args = ["-e", "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({available:false})))"];
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(c));
    let state = initRunState({ repository: "acme/product", runId: "test", requirement: "REQ-001", spec: "SPEC-001" });
    state.readiness = { schemaVersion: 1, revision: "revision", implementationKey: "issue", work: [{ key: "work", revision: "revision", kind: "implementation", executorId: "synthetic", attempt: 1, issue: 96 }] };
    const store = { load: async () => structuredClone(state), save: async (next: typeof state) => { state = structuredClone(next); } };
    const confirmAudit = vi.fn(async () => {});
    await expect(runReadinessExecuteCommand({ repository: "acme/product", runIssue: 97, workKey: "work", receipt: "github-actions:123", configPath: "trusted.json" }, { store, confirmAudit })).rejects.toThrow("no agent work was started");
    expect(state.readiness?.work[0].execution).toBeUndefined();
    expect(state.readiness?.decision?.action).toBe("await-executor");
    expect(state.readiness?.work[0].deferral?.receipt).toBe("github-actions:123");
    expect(confirmAudit).toHaveBeenCalledTimes(1);
  });
  it("refuses an unbound production runtime rather than misattributing the audit actor", async () => {
    await expect(runReadinessExecuteCommand({ repository: "acme/nonmatching", runIssue: 97, workKey: "work", receipt: "invalid", configPath: "trusted.json" })).rejects.toThrow("bound GitHub Actions runtime");
  });
  it("rejects duplicate work and mismatched identities before probes or state changes", async () => {
    for (const kind of ["duplicate", "receipt", "executor", "revision"]) {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(config()));
      const state = initRunState({ repository: "acme/product", runId: "test", requirement: "REQ-001", spec: "SPEC-001" });
      state.readiness = { schemaVersion: 1, revision: "revision", implementationKey: "issue", work: [{ key: "work", revision: "revision", kind: "implementation", executorId: "synthetic", attempt: 1, issue: 96, receipt: "github-actions:123" }] };
      const work = state.readiness.work[0];
      if (kind === "duplicate") state.readiness.work.push({ ...work });
      if (kind === "receipt") work.receipt = "github-actions:456";
      if (kind === "executor") work.executorId = "other";
      if (kind === "revision") work.revision = "old";
      const store = { load: async () => structuredClone(state), save: vi.fn(async () => {}) };
      const confirmAudit = vi.fn(async () => {});
      await expect(runReadinessExecuteCommand({ repository: "acme/product", runIssue: 97, workKey: "work", receipt: "github-actions:123", configPath: "trusted.json" }, { store, confirmAudit })).rejects.toThrow();
      expect(store.save).not.toHaveBeenCalled();
      expect(confirmAudit).not.toHaveBeenCalled();
    }
  });
});
