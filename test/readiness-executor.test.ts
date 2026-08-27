import { describe, expect, it, vi } from "vitest";
import { executeReadinessWork, runReadinessCommand, type ReadinessCommand } from "../src/spec/readiness-executor.js";
import { initRunState } from "../src/state/state-machine.js";

function command(code: string): ReadinessCommand {
  return { executable: process.execPath, args: ["-e", code], cwd: process.cwd(), timeoutMs: 5000, env: {} };
}
const readInput = "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{";
function setup() {
  let state = initRunState({ runId: "test", repository: "acme/product", spec: "SPEC-001", requirement: "REQ-001" });
  state.readiness = { schemaVersion: 1, revision: "revision", implementationKey: "issue", work: [{
    key: "work", revision: "revision", kind: "spike", executorId: "synthetic", blockerId: "coordinates", attempt: 1, issue: 96,
  }] };
  const savedStatuses: Array<string | undefined> = [];
  const store = { load: async () => structuredClone(state), save: vi.fn(async (next: typeof state) => {
    state = structuredClone(next); savedStatuses.push(state.readiness?.work[0].execution?.status);
  }) };
  const input = { store, workKey: "work", receipt: "github-actions:123", costCeiling: 0,
    policy: { id: "synthetic", authorized: true, available: true, capabilities: ["spike" as const], maxTaskCost: 0 },
    blocker: { id: "coordinates", kind: "technical" as const, stage: "implementation" as const, owner: "research", question: "Coordinates?", criteria: ["coordinates exist"], maxAttempts: 2 },
    agent: command(`${readInput}console.log(JSON.stringify({latitude:48,longitude:11}));});`),
    verifier: command(`${readInput}const x=JSON.parse(s); const ok=x.candidate.latitude===48 && x.candidate.longitude===11;console.log(JSON.stringify({blockerId:x.blocker.id,specRevision:x.specRevision,verdict:ok?'passed':'failed',verifiedCriteria:ok?['coordinates exist']:[],references:['synthetic:coordinates-fixture'],changes:[]}));});`),
    confirmAudit: vi.fn(async () => {}),
  };
  return { input, savedStatuses, state: () => state };
}
describe("SPEC-016 executable readiness receiver protocol", () => {
  it("runs real subprocesses, verifies the candidate independently and reuses persisted output", async () => {
    const f = setup();
    const result = await executeReadinessWork(f.input);
    expect(result).toMatchObject({ verdict: "passed", verifiedCriteria: ["coordinates exist"] });
    expect(f.savedStatuses).toEqual(["claimed", "completed"]);
    expect(f.state().readiness?.work[0].execution?.status).toBe("completed");
    f.input.agent = command("process.exit(99)");
    expect(await executeReadinessWork(f.input)).toEqual(result);
  });
  it("reserves work durably before any subprocess and refuses interrupted claims", async () => {
    const f = setup(); f.input.confirmAudit.mockRejectedValueOnce(new Error("audit down"));
    await expect(executeReadinessWork(f.input)).rejects.toThrow("audit down");
    expect(f.state().readiness?.work[0].execution?.status).toBe("claimed");
    await expect(executeReadinessWork(f.input)).rejects.toThrow("refusing duplicate");
  });
  it("rejects exhausted/unavailable policy before claiming work", async () => {
    const f = setup(); f.input.policy.available = false;
    await expect(executeReadinessWork(f.input)).rejects.toThrow("unauthorized");
    expect(f.input.store.save).not.toHaveBeenCalled();
  });
  it("does not accept an agent self-report when the independent verifier fails", async () => {
    const f = setup(); f.input.verifier = command("process.exit(1)");
    await expect(executeReadinessWork(f.input)).rejects.toThrow("execution failed");
    expect(f.state().readiness?.work[0].execution?.status).toBe("failed");
    expect(f.state().readiness?.work[0].execution?.output).toBeUndefined();
    await expect(executeReadinessWork(f.input)).rejects.toThrow("refusing duplicate");
  });
  it("rejects completion claims without all required criteria", async () => {
    const f = setup(); f.input.verifier = command(`console.log(JSON.stringify({blockerId:'coordinates',specRevision:'revision',verdict:'passed',verifiedCriteria:[],references:['synthetic:test'],changes:[]}))`);
    await expect(executeReadinessWork(f.input)).rejects.toThrow("execution failed");
  });
  it("passes untrusted text as stdin data, does not inherit the process environment", async () => {
    const candidate = "$(echo unsafe); `command`";
    expect(await runReadinessCommand(command(`${readInput}console.log(JSON.stringify({input:JSON.parse(s),env:process.env.HARNESS_TEST_PRIVATE_VALUE??null}));});`), candidate)).toEqual({ input: candidate, env: null });
  });
  it("bounds output, runtime and malformed command responses", async () => {
    await expect(runReadinessCommand(command("console.log('x'.repeat(300000))"), {})).rejects.toThrow("output limit");
    await expect(runReadinessCommand({ ...command("setInterval(()=>{},1000)"), timeoutMs: 50 }, {})).rejects.toThrow("timed out");
    await expect(runReadinessCommand(command("console.log('invalid')"), {})).rejects.toThrow("invalid JSON");
  });
});
