import { describe, expect, it } from "vitest";
import { detectStalledRuns } from "../src/watchdog/stall-detection.js";
import { initRunState, upsertGate } from "../src/state/state-machine.js";
import { findWorkflowTemplate, renderStallWatchdogReference } from "../src/workflows/template-catalog.js";

const NOW = "2026-08-24T12:00:00.000Z";

function stalled() {
  return {
    ...initRunState({ runId: "watchdog-1", repository: "org/repo", requirement: "REQ-011", spec: "SPEC-011" }),
    phase: "implementation" as const,
    updatedAt: "2026-08-24T10:00:00.000Z",
  };
}

describe("detectStalledRuns", () => {
  it("finds one overdue implementation assignment (TAC-01)", () => {
    expect(detectStalledRuns([stalled()], NOW, { staleAfterMinutes: 45, maxNudges: 3 })).toEqual([
      expect.objectContaining({ runId: "watchdog-1", actionKey: "agent-assign", disposition: "nudge", nudgeCount: 0 }),
    ]);
  });

  it("skips pending human gates, fresh and complete runs (TAC-02/04/06)", () => {
    const gated = upsertGate(stalled(), { id: "decision", type: "human", question: "Decide" });
    const fresh = { ...stalled(), runId: "fresh", updatedAt: "2026-08-24T11:30:00.000Z" };
    const complete = { ...stalled(), runId: "done", phase: "complete" as const };
    expect(detectStalledRuns([gated, fresh, complete], NOW, { staleAfterMinutes: 45, maxNudges: 3 })).toEqual([]);
  });

  it("marks an exhausted run for exactly one escalation path (TAC-05)", () => {
    const state = { ...stalled(), watchdog: { nudges: [0, 1, 2].map(() => ({ actionKey: "agent-assign", dispatchedAt: "2026-08-24T10:00:00.000Z", outcome: "failed" as const })) } };
    expect(detectStalledRuns([state], NOW, { staleAfterMinutes: 45, maxNudges: 3 })[0]).toEqual(expect.objectContaining({ disposition: "escalate", nudgeCount: 3 }));
  });

  it("uses the latest nudge as cooldown reference (TAC-09)", () => {
    const state = { ...stalled(), watchdog: { nudges: [{ actionKey: "agent-assign", dispatchedAt: "2026-08-24T11:30:00.000Z", outcome: "dispatched" as const }] } };
    expect(detectStalledRuns([state], NOW, { staleAfterMinutes: 45, maxNudges: 3 })).toEqual([]);
  });
});

describe("stall-watchdog workflow template", () => {
  it("is catalogued and scheduled with minimal permissions (TAC-12/14)", () => {
    expect(findWorkflowTemplate("stall-watchdog")?.targetPath).toBe(".github/workflows/harness-stall-watchdog.yml");
    const rendered = renderStallWatchdogReference({ harnessRef: "v1.2.3" });
    expect(rendered).toContain('cron: "*/30 * * * *"');
    expect(rendered).toContain("contents: read");
    expect(rendered).toContain("issues: write");
    expect(rendered).not.toContain("secrets: inherit");
  });
});
