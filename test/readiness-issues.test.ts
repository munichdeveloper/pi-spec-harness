import { describe, expect, it, vi } from "vitest";
import { ensureReadinessImplementationIssue, ensureReadinessSpikeIssue } from "../src/spec/readiness-issues.js";

const repository = "acme/product";
const key = `readiness-${"a".repeat(64)}`;
const input = { key, specId: "SPEC-001", title: "Feature", body: "Approved scope" };
function setup() {
  const issues: Array<{ number: number; title: string; body: string; state: string; url: string }> = [];
  const api = {
    listReadinessIssues: vi.fn(async () => structuredClone(issues)),
    createIssue: vi.fn(async (_repo: string, issue: { title: string; body: string }) => {
      const number = issues.length + 1;
      const url = `https://github.com/${repository}/issues/${number}`;
      issues.push({ ...issue, number, url, state: "open" });
      return { repository, number, url };
    }),
  };
  return { issues, api };
}

describe("SPEC-016 GitHub issue materialization", () => {
  it("adopts an exact legacy spec issue without changing user content or dispatching", async () => {
    const f = setup();
    f.issues.push({ number: 96, title: "SPEC-001: Legacy", body: "User content", state: "OPEN", url: "url" });
    expect(await ensureReadinessImplementationIssue(repository, input, f.api)).toBe(96);
    expect(f.api.createIssue).not.toHaveBeenCalled();
    expect(f.issues[0].body).toBe("User content");
  });
  it("does not confuse spec prefixes and recovers a creation whose response was lost", async () => {
    const f = setup();
    f.issues.push({ number: 1, title: "SPEC-0010: Other", body: "", state: "open", url: "url" });
    const create = f.api.createIssue.getMockImplementation()!;
    f.api.createIssue.mockImplementationOnce(async (...args) => { await create(...args); throw new Error("response lost"); });
    await expect(ensureReadinessImplementationIssue(repository, input, f.api)).rejects.toThrow("response lost");
    expect(await ensureReadinessImplementationIssue(repository, input, f.api)).toBe(2);
    expect(f.api.createIssue).toHaveBeenCalledTimes(1);
    expect(f.api.createIssue.mock.calls[0][1]).not.toHaveProperty("labels");
  });
  it("rejects closed, ambiguous and conflicting implementation identities", async () => {
    const f = setup();
    f.issues.push({ number: 96, title: "SPEC-001: Legacy", body: "", state: "closed", url: "url" });
    await expect(ensureReadinessImplementationIssue(repository, input, f.api)).rejects.toThrow("closed");
    f.issues[0].state = "open";
    f.issues[0].body = `<!-- harness:readiness:readiness-${"b".repeat(64)} -->`;
    await expect(ensureReadinessImplementationIssue(repository, input, f.api)).rejects.toThrow("conflicting");
    f.issues.push({ ...f.issues[0], number: 97 });
    await expect(ensureReadinessImplementationIssue(repository, input, f.api)).rejects.toThrow("Ambiguous");
    expect(f.api.createIssue).not.toHaveBeenCalled();
  });
  it("creates a bounded owned spike and reuses it even after manual closure", async () => {
    const f = setup();
    const spike = {
      specId: "SPEC-001", implementationIssue: 96,
      work: { key, kind: "spike" as const, blockerId: "coordinates", revision: "sha", executorId: "test", attempt: 1 },
      blocker: { id: "coordinates", kind: "technical" as const, stage: "implementation" as const, owner: "research", question: "Coordinates available?", criteria: ["Reproducible sample"], maxAttempts: 2 },
    };
    expect(await ensureReadinessSpikeIssue(repository, spike, f.api)).toBe(1);
    expect(f.issues[0].body).toContain("Owner: research");
    expect(f.issues[0].body).toContain("Reproducible sample");
    expect(f.issues[0].body).toContain("1/2");
    f.issues[0].state = "closed";
    expect(await ensureReadinessSpikeIssue(repository, spike, f.api)).toBe(1);
    expect(f.api.createIssue).toHaveBeenCalledTimes(1);
    await expect(ensureReadinessSpikeIssue(repository, { ...spike, work: { ...spike.work, attempt: 3 } }, f.api)).rejects.toThrow("binding");
  });
});
