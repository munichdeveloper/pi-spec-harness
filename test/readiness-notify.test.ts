import { describe, expect, it, vi } from "vitest";
import { notifyReadinessCompletion } from "../src/spec/readiness-notify.js";

describe("readiness completion notification", () => {
  it("uses only the Actions repository and run identity", async () => {
    const api = { notifyReadinessReconciliation: vi.fn(async () => {}) };
    await notifyReadinessCompletion({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/harness", GITHUB_RUN_ID: "123" }, api);
    expect(api.notifyReadinessReconciliation).toHaveBeenCalledWith("acme/harness", "123");
  });
  it.each([
    {},
    { GITHUB_ACTIONS: "false", GITHUB_REPOSITORY: "acme/harness", GITHUB_RUN_ID: "123" },
    { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "../other", GITHUB_RUN_ID: "123" },
    { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/harness", GITHUB_RUN_ID: "0" },
  ])("rejects invalid execution identity without dispatch", async env => {
    const api = { notifyReadinessReconciliation: vi.fn(async () => {}) };
    await expect(notifyReadinessCompletion(env, api)).rejects.toThrow("Actions execution");
    expect(api.notifyReadinessReconciliation).not.toHaveBeenCalled();
  });
  it("propagates delivery failure so scheduled reconciliation remains the fallback", async () => {
    const api = { notifyReadinessReconciliation: vi.fn(async () => { throw new Error("unavailable"); }) };
    await expect(notifyReadinessCompletion({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/harness", GITHUB_RUN_ID: "123" }, api)).rejects.toThrow("unavailable");
  });
});
