import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODING_AGENT,
  extractReferencedIssueNumbers,
  pollForAgentAssignment,
  recordVerifiedAgentAssignment,
} from "../src/agent/assignment.js";
import { buildAgentAssignmentArgs } from "../src/github/gh.js";
import { initRunState, upsertGate } from "../src/state/state-machine.js";

describe("reactive coding-agent handoff", () => {
  it("publishes the canonical Copilot coding-agent login as the default", () => {
    expect(DEFAULT_CODING_AGENT).toBe("copilot-swe-agent[bot]");
  });
  it("uses GitHub's current agent-assignment field contract", () => {
    const args = buildAgentAssignmentArgs("owner/repo", 62, "copilot-swe-agent[bot]", "main");
    expect(args).toContain("assignees[]=copilot-swe-agent[bot]");
    expect(args).toContain("agent_assignment[target_repo]=owner/repo");
    expect(args).toContain("agent_assignment[base_branch]=main");
    expect(args.join(" ")).not.toContain("base_ref");
  });

  it("retries an eventually-consistent assignment and stops when verified", async () => {
    let reads = 0;
    const sleeps: number[] = [];
    const result = await pollForAgentAssignment(
      async () => ({
        assignees: reads++ < 2 ? [] : [{ login: "Copilot-SWE-Agent[bot]" }],
        url: "https://github.com/owner/repo/issues/62",
      }),
      "copilot-swe-agent[bot]",
      { attempts: 4, delayMs: 10, sleep: async (ms) => { sleeps.push(ms); } },
    );
    expect(result.assigned).toBe(true);
    expect(result.attempts).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });

  it("supersedes an assignment false-positive without manufacturing a human decision", () => {
    let state = initRunState({
      runId: "issue-62", repository: "owner/repo", requirement: "REQ-011", spec: "SPEC-011",
    });
    state = upsertGate(state, {
      id: "agent-assign-unverified", type: "human", question: "Verify assignment",
    });
    const result = recordVerifiedAgentAssignment(state, {
      assignee: "copilot-swe-agent[bot]", baseRef: "main",
      issueUrl: "https://github.com/owner/repo/issues/62", verifiedAt: "2026-08-23T12:00:00Z",
    });
    const gate = result.state.gates.find((candidate) => candidate.id === "agent-assign-unverified");
    expect(result.supersededGateIds).toEqual(["agent-assign-unverified"]);
    expect(gate?.result).toBe("passed");
    expect(gate?.decision).toBeUndefined();
    expect(result.state.agentAssignment?.assignee).toBe("copilot-swe-agent[bot]");
  });

  it("extracts and deduplicates implementation issue references from an agent PR", () => {
    expect(extractReferencedIssueNumbers("Closes #62; see https://github.com/owner/repo/issues/62"))
      .toEqual([62]);
  });
});
