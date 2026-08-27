import { describe, expect, it, vi } from "vitest";
import { ensureReadinessRun } from "../src/spec/readiness-run.js";
import { initRunState } from "../src/state/state-machine.js";
import { renderStateBody } from "../src/state/issue-store.js";

const input = { repository: "acme/product", specId: "SPEC-001", requirementId: "REQ-001", specPath: "docs/SPEC-001.md", approvedRevision: "a".repeat(40), approvalEvidence: "https://github.com/acme/product/commit/" + "a".repeat(40), implementationIssue: 96 };
function setup() {
  const issues: Array<{ number: number; title: string; body: string; state: string; url: string }> = [];
  const api = {
    listReadinessIssues: vi.fn(async () => structuredClone(issues)),
    ensureLabel: vi.fn(async () => {}),
    createIssue: vi.fn(async (repository: string, issue: { title: string; body: string; labels?: string[] }) => {
      const number = 100 + issues.length;
      const url = `https://github.com/${repository}/issues/${number}`;
      issues.push({ ...issue, number, url, state: "open" });
      return { repository, number, url };
    }),
  };
  return { issues, api };
}
describe("SPEC-016 canonical readiness run bootstrap", () => {
  it("creates one issue-backed run with bound provenance and recovers a lost create response", async () => {
    const f = setup();
    const create = f.api.createIssue.getMockImplementation()!;
    f.api.createIssue.mockImplementationOnce(async (...args) => { await create(...args); throw new Error("response lost"); });
    await expect(ensureReadinessRun(input, f.api)).rejects.toThrow("response lost");
    const recovered = await ensureReadinessRun(input, f.api);
    expect(recovered.created).toBe(false);
    expect(recovered.state.issue).toBe(96);
    expect(recovered.state.gates[0].evidence).toContain(`approved-spec-revision:${input.approvedRevision}`);
    expect(f.api.createIssue).toHaveBeenCalledTimes(1);
  });
  it("adopts a legacy run without overwriting its gates, name or progress", async () => {
    const f = setup();
    const state = initRunState({ runId: "RUN-0097", repository: input.repository, requirement: input.requirementId, spec: input.specId, issue: 96 });
    state.phase = "verification";
    f.issues.push({ number: 97, title: "[Harness Run] RUN-0097", body: renderStateBody(state), state: "open", url: "url" });
    expect((await ensureReadinessRun(input, f.api)).state).toEqual(state);
    expect(f.api.createIssue).not.toHaveBeenCalled();
  });
  it("fails closed on ambiguous, closed, malformed and conflicting canonical state", async () => {
    const f = setup(); await ensureReadinessRun(input, f.api);
    f.issues[0].state = "closed";
    await expect(ensureReadinessRun(input, f.api)).rejects.toThrow("closed");
    f.issues[0].state = "open";
    await expect(ensureReadinessRun({ ...input, requirementId: "REQ-002" }, f.api)).rejects.toThrow("immutable");
    f.issues.push({ ...f.issues[0], number: 101 });
    await expect(ensureReadinessRun(input, f.api)).rejects.toThrow("Multiple");
    f.issues[1].body = "broken";
    await expect(ensureReadinessRun(input, f.api)).rejects.toThrow("Unreadable");
    expect(f.api.createIssue).toHaveBeenCalledTimes(1);
  });
  it("rejects missing provenance before any GitHub access", async () => {
    const f = setup();
    await expect(ensureReadinessRun({ ...input, approvedRevision: "main" }, f.api)).rejects.toThrow("provenance");
    expect(f.api.listReadinessIssues).not.toHaveBeenCalled();
  });
});
