/**
 * Tests for SPEC-014 (Requirement-to-Spec pipeline) and SPEC-015
 * (Merge-as-Approval for protected PRs).
 */

import { describe, expect, it } from "vitest";
import {
  buildSpecDispatchKey,
  classifyRequirementForSpecGeneration,
  effectivePrApprovalPolicy,
  findSpecDispatch,
  initRunState,
  isMergeAsApproval,
  isMergeApprovalGate,
  needsDeliveryMergeReconciliation,
  recordDeliveryMergeEffect,
  bindDeliveryPullRequest,
  resolveGate,
  upsertGate,
  upsertSpecDispatch,
} from "../src/state/state-machine.js";
import type { SpecDispatchRecord } from "../src/state/types.js";
import {
  buildDispatchKey,
  buildSpecDispatchOrder,
  deriveSpecPath,
  isRequirementEligible,
  parseRequirementFrontmatter,
} from "../src/spec/requirement-to-spec.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function baseRun(prApprovalPolicy?: "merge-is-approval" | "label-authorizes-auto-merge") {
  return initRunState({
    runId: "test-spec014-015",
    repository: "munichdeveloper/Immogent",
    requirement: "REQ-014",
    spec: "SPEC-014",
    prApprovalPolicy,
  });
}

function sha(char: string) {
  return char.repeat(40);
}

// ---------------------------------------------------------------------------
// SPEC-015: PR approval policy
// ---------------------------------------------------------------------------

describe("SPEC-015: prApprovalPolicy", () => {
  it("TAC-07: new runs default to merge-is-approval", () => {
    const state = baseRun();
    expect(state.prApprovalPolicy).toBe("merge-is-approval");
    expect(effectivePrApprovalPolicy(state)).toBe("merge-is-approval");
    expect(isMergeAsApproval(state)).toBe(true);
  });

  it("TAC-07: legacy runs without the field default to label-authorizes-auto-merge", () => {
    // Simulate a pre-SPEC-015 run state that has no prApprovalPolicy field.
    const state = baseRun();
    const legacyState = { ...state, prApprovalPolicy: undefined };
    expect(effectivePrApprovalPolicy(legacyState)).toBe("label-authorizes-auto-merge");
    expect(isMergeAsApproval(legacyState)).toBe(false);
  });

  it("TAC-07: explicitly setting label-authorizes-auto-merge is preserved", () => {
    const state = baseRun("label-authorizes-auto-merge");
    expect(state.prApprovalPolicy).toBe("label-authorizes-auto-merge");
    expect(effectivePrApprovalPolicy(state)).toBe("label-authorizes-auto-merge");
    expect(isMergeAsApproval(state)).toBe(false);
  });

  it("TAC-01: merge-is-approval run records delivery merge without a pre-existing gate", () => {
    const headSha = sha("a");
    let state = bindDeliveryPullRequest(baseRun("merge-is-approval"), 42, headSha);

    // No approval gate exists yet — this is valid under merge-is-approval policy.
    state = recordDeliveryMergeEffect(state, {
      pullRequest: 42,
      approvedHeadSha: headSha,
      mergeCommitSha: sha("b"),
      mergedAt: "2026-08-24T10:00:00Z",
      mergedBy: "munichdeveloper",
    });

    expect(state.deliveryMergeCommitSha).toBe(sha("b"));
    expect(state.deliveryMergedAt).toBe("2026-08-24T10:00:00Z");
    // A gate must have been auto-created with type "merge" and passed.
    const mergeGate = state.gates.find((g) => isMergeApprovalGate(g));
    expect(mergeGate).toBeDefined();
    expect(mergeGate!.result).toBe("passed");
    expect(mergeGate!.type).toBe("merge");
    expect(mergeGate!.decision?.approved).toBe(true);
    expect(mergeGate!.decision?.by).toBe("munichdeveloper");
  });

  it("TAC-01: label-authorizes-auto-merge still requires a pre-existing passed gate", () => {
    const headSha = sha("a");
    const state = bindDeliveryPullRequest(baseRun("label-authorizes-auto-merge"), 42, headSha);

    expect(() =>
      recordDeliveryMergeEffect(state, {
        pullRequest: 42,
        approvedHeadSha: headSha,
        mergeCommitSha: sha("b"),
        mergedBy: "human-user",
        mergedAt: "2026-08-24T10:00:00Z",
      }),
    ).toThrow(/passed merge approval gate/);
  });

  it("TAC-02: unmerged PR is never treated as approved (no persisted evidence = pending)", () => {
    const state = bindDeliveryPullRequest(baseRun("merge-is-approval"), 42, sha("a"));
    // No recordDeliveryMergeEffect called → no evidence, so not yet approved.
    // For merge-is-approval runs the reconciler must poll GitHub to detect the
    // merge event, so needsDeliveryMergeReconciliation returns true (pending check).
    expect(needsDeliveryMergeReconciliation(state)).toBe(true);
    expect(state.deliveryMergeCommitSha).toBeUndefined();
  });

  it("TAC-03: SHA mismatch in merge event is rejected", () => {
    const headSha = sha("a");
    const state = bindDeliveryPullRequest(baseRun("merge-is-approval"), 42, headSha);

    expect(() =>
      recordDeliveryMergeEffect(state, {
        pullRequest: 42,
        approvedHeadSha: sha("f"), // valid hex but wrong head
        mergeCommitSha: sha("b"),
        mergedBy: "human-user",
        mergedAt: "2026-08-24T10:00:00Z",
      }),
    ).toThrow(/expected approved head/);
  });

  it("TAC-05: recordDeliveryMergeEffect is idempotent for the same SHA/effect", () => {
    const headSha = sha("a");
    let state = bindDeliveryPullRequest(baseRun("merge-is-approval"), 42, headSha);
    const effect = {
      pullRequest: 42,
      approvedHeadSha: headSha,
      mergeCommitSha: sha("b"),
      mergedBy: "human-user",
      mergedAt: "2026-08-24T10:00:00Z",
    };
    state = recordDeliveryMergeEffect(state, effect);
    // Second call must return the same state (idempotent).
    const stateAfterSecondCall = recordDeliveryMergeEffect(state, effect);
    expect(stateAfterSecondCall.deliveryMergeCommitSha).toBe(sha("b"));
    expect(stateAfterSecondCall.gates).toHaveLength(state.gates.length);
  });

  it("TAC-01: merge-is-approval run with an existing passed gate uses that gate without creating a duplicate", () => {
    const headSha = sha("a");
    let state = bindDeliveryPullRequest(baseRun("merge-is-approval"), 42, headSha);
    // Pre-create and pass a gate (e.g. from a label-based approval still in flight).
    state = upsertGate(state, { id: "delivery-merge-approval", type: "human", question: "Merge?" });
    state = resolveGate(state, "delivery-merge-approval", {
      result: "passed",
      decision: { approved: true, by: "user", at: "2026-08-24T09:00:00Z" },
    });

    state = recordDeliveryMergeEffect(state, {
      pullRequest: 42,
      approvedHeadSha: headSha,
      mergeCommitSha: sha("b"),
      mergedBy: "human-user",
      mergedAt: "2026-08-24T10:00:00Z",
    });

    // Must not duplicate the gate.
    expect(state.gates.filter(isMergeApprovalGate)).toHaveLength(1);
    expect(state.deliveryMergeCommitSha).toBe(sha("b"));
  });
});

// ---------------------------------------------------------------------------
// SPEC-014: classifyRequirementForSpecGeneration (state-machine helper)
// ---------------------------------------------------------------------------

describe("SPEC-014: classifyRequirementForSpecGeneration (state-machine)", () => {
  const repo = "munichdeveloper/Immogent";
  const reqId = "REQ-014";
  const sourceSha = sha("1");

  it("TAC-01: returns eligible when outbox is empty", () => {
    expect(classifyRequirementForSpecGeneration(undefined, repo, reqId, sourceSha)).toBe("eligible");
    expect(classifyRequirementForSpecGeneration([], repo, reqId, sourceSha)).toBe("eligible");
  });

  it("TAC-01: returns already-dispatched when same key has an active dispatch", () => {
    const key = buildSpecDispatchKey(repo, reqId, sourceSha);
    const record: SpecDispatchRecord = {
      schemaVersion: 1,
      dispatchKey: key,
      requirementId: reqId,
      sourceSha,
      targetSpecPath: "docs/specifications/SPEC-014.md",
      provider: "github-copilot",
      branch: "harness/spec-gen-req-014",
      status: "dispatched",
      requestedAt: "2026-08-24T09:00:00Z",
      updatedAt: "2026-08-24T09:00:00Z",
    };
    expect(classifyRequirementForSpecGeneration([record], repo, reqId, sourceSha)).toBe("already-dispatched");
  });

  it("TAC-01: returns already-materialized when PR is merged", () => {
    const key = buildSpecDispatchKey(repo, reqId, sourceSha);
    const record: SpecDispatchRecord = {
      schemaVersion: 1,
      dispatchKey: key,
      requirementId: reqId,
      sourceSha,
      targetSpecPath: "docs/specifications/SPEC-014.md",
      provider: "github-copilot",
      branch: "harness/spec-gen-req-014",
      status: "pr-merged",
      requestedAt: "2026-08-24T09:00:00Z",
      updatedAt: "2026-08-24T09:00:00Z",
    };
    expect(classifyRequirementForSpecGeneration([record], repo, reqId, sourceSha)).toBe("already-materialized");
  });

  it("TAC-03: returns blocked when same req has an older unmerged dispatch", () => {
    const oldSha = sha("0");
    const oldKey = buildSpecDispatchKey(repo, reqId, oldSha);
    const record: SpecDispatchRecord = {
      schemaVersion: 1,
      dispatchKey: oldKey,
      requirementId: reqId,
      sourceSha: oldSha,
      targetSpecPath: "docs/specifications/SPEC-014.md",
      provider: "github-copilot",
      branch: "harness/spec-gen-req-014",
      status: "pr-open",
      requestedAt: "2026-08-24T09:00:00Z",
      updatedAt: "2026-08-24T09:00:00Z",
    };
    // New SHA, same req → blocked until old draft is cancelled/merged.
    expect(classifyRequirementForSpecGeneration([record], repo, reqId, sha("2"))).toBe("blocked");
  });

  it("TAC-03: cancelled dispatch allows a new eligible dispatch for the same req", () => {
    const oldSha = sha("0");
    const oldKey = buildSpecDispatchKey(repo, reqId, oldSha);
    const record: SpecDispatchRecord = {
      schemaVersion: 1,
      dispatchKey: oldKey,
      requirementId: reqId,
      sourceSha: oldSha,
      targetSpecPath: "docs/specifications/SPEC-014.md",
      provider: "github-copilot",
      branch: "harness/spec-gen-req-014",
      status: "cancelled",
      requestedAt: "2026-08-24T09:00:00Z",
      updatedAt: "2026-08-24T09:00:00Z",
    };
    expect(classifyRequirementForSpecGeneration([record], repo, reqId, sha("2"))).toBe("eligible");
  });
});

// ---------------------------------------------------------------------------
// SPEC-014: upsertSpecDispatch / findSpecDispatch (state-machine helpers)
// ---------------------------------------------------------------------------

describe("SPEC-014: spec-dispatch outbox helpers", () => {
  it("upsertSpecDispatch appends a new record", () => {
    const state = baseRun();
    const record: SpecDispatchRecord = {
      schemaVersion: 1,
      dispatchKey: buildSpecDispatchKey(state.repository, "REQ-014", sha("1")),
      requirementId: "REQ-014",
      sourceSha: sha("1"),
      targetSpecPath: "docs/specifications/SPEC-014.md",
      provider: "github-copilot",
      branch: "harness/spec-gen-req-014",
      status: "prepared",
      requestedAt: "2026-08-24T09:00:00Z",
      updatedAt: "2026-08-24T09:00:00Z",
    };
    const next = upsertSpecDispatch(state, record);
    expect(next.specGenerationOutbox).toHaveLength(1);
    expect(findSpecDispatch(next, record.dispatchKey)).toEqual(record);
  });

  it("upsertSpecDispatch updates an existing record by key", () => {
    const state = baseRun();
    const key = buildSpecDispatchKey(state.repository, "REQ-014", sha("1"));
    const record: SpecDispatchRecord = {
      schemaVersion: 1,
      dispatchKey: key,
      requirementId: "REQ-014",
      sourceSha: sha("1"),
      targetSpecPath: "docs/specifications/SPEC-014.md",
      provider: "github-copilot",
      branch: "harness/spec-gen-req-014",
      status: "prepared",
      requestedAt: "2026-08-24T09:00:00Z",
      updatedAt: "2026-08-24T09:00:00Z",
    };
    let next = upsertSpecDispatch(state, record);
    next = upsertSpecDispatch(next, { ...record, status: "dispatched" });
    expect(next.specGenerationOutbox).toHaveLength(1);
    expect(findSpecDispatch(next, key)!.status).toBe("dispatched");
  });
});

// ---------------------------------------------------------------------------
// SPEC-014: requirement-to-spec pure functions
// ---------------------------------------------------------------------------

describe("SPEC-014: parseRequirementFrontmatter", () => {
  it("TAC-01: parses a valid approved requirement", () => {
    const content = `---
id: REQ-014
type: requirement
title: Agent-generated Software Spec
status: approved
owner: product
risk: medium
created: 2026-08-24
updated: 2026-08-24
---

# REQ-014: ...
`;
    const fm = parseRequirementFrontmatter(content);
    expect(fm.id).toBe("REQ-014");
    expect(fm.type).toBe("requirement");
    expect(fm.status).toBe("approved");
    expect(fm.title).toBe("Agent-generated Software Spec");
    expect(fm.owner).toBe("product");
  });

  it("TAC-01: throws when a required field is missing", () => {
    const content = `---
type: requirement
title: Missing id
status: approved
---
# body
`;
    expect(() => parseRequirementFrontmatter(content)).toThrow(/missing required field 'id'/);
  });
});

describe("SPEC-014: isRequirementEligible", () => {
  it("TAC-01: returns true for approved requirements", () => {
    expect(isRequirementEligible({ id: "REQ-014", type: "requirement", title: "T", status: "approved" })).toBe(true);
  });

  it("TAC-01: returns false for non-approved status", () => {
    expect(isRequirementEligible({ id: "REQ-014", type: "requirement", title: "T", status: "draft" })).toBe(false);
    expect(isRequirementEligible({ id: "REQ-014", type: "requirement", title: "T", status: "deprecated" })).toBe(false);
  });

  it("TAC-01: returns false for non-requirement type", () => {
    expect(isRequirementEligible({ id: "SPEC-014", type: "software-spec", title: "T", status: "approved" })).toBe(false);
  });
});

describe("SPEC-014: deriveSpecPath", () => {
  it("TAC-03: derives the SPEC path from a REQ id", () => {
    expect(deriveSpecPath("REQ-014")).toBe("docs/specifications/SPEC-014.md");
    expect(deriveSpecPath("REQ-001")).toBe("docs/specifications/SPEC-001.md");
    expect(deriveSpecPath("REQ-015")).toBe("docs/specifications/SPEC-015.md");
  });

  it("uses a configurable base directory", () => {
    expect(deriveSpecPath("REQ-014", "src/specs")).toBe("src/specs/SPEC-014.md");
  });
});

describe("SPEC-014: buildSpecDispatchOrder", () => {
  it("TAC-04: builds a fully populated dispatch order with defaults", () => {
    const order = buildSpecDispatchOrder({
      repository: "munichdeveloper/Immogent",
      requirementId: "REQ-014",
      sourceSha: sha("1"),
      requirementPath: "docs/requirements/REQ-014-agent-generated-software-spec.md",
    });
    expect(order.dispatchKey).toBe(buildDispatchKey("munichdeveloper/Immogent", "REQ-014", sha("1")));
    expect(order.provider).toBe("github-copilot");
    expect(order.targetSpecPath).toBe("docs/specifications/SPEC-014.md");
    expect(order.requiredSections).toContain("Architektur");
    expect(order.requiredSections).toContain("Technische Akzeptanzkriterien");
    // AC-04: spec must contain traceability, decisions, risks, and open questions
    expect(order.requiredSections).toContain("Rückverfolgbarkeit");
    expect(order.requiredSections).toContain("Risiken");
    expect(order.requiredSections).toContain("Offene Fragen");
    expect(order.requiredSections).not.toContain("Rollback");
    expect(order.agentBranch).toMatch(/^harness\/spec-gen-req-014-/);
  });

  it("TAC-04: honours explicit provider override", () => {
    const order = buildSpecDispatchOrder({
      repository: "munichdeveloper/Immogent",
      requirementId: "REQ-014",
      sourceSha: sha("1"),
      requirementPath: "docs/requirements/REQ-014.md",
      provider: "claude-code",
    });
    expect(order.provider).toBe("claude-code");
  });
});

// ---------------------------------------------------------------------------
// Additional production-path tests (remediation of remaining feedback items)
// ---------------------------------------------------------------------------

describe("SPEC-014: deriveSpecPath separator (REQ-014-agent-generated-software-spec)", () => {
  it("produces the correct slug-separated filename for a composite REQ id", () => {
    const path = deriveSpecPath("REQ-014-agent-generated-software-spec");
    // Must be SPEC-014-agent-generated-software-spec.md, not SPEC-014agent-...
    expect(path).toBe("docs/specifications/SPEC-014-agent-generated-software-spec.md");
    expect(path).not.toMatch(/SPEC-014[^-]/);
  });
});

describe("SPEC-014: upsertSpecDispatch monotonicity", () => {
  it("allows a forward status transition (prepared → dispatched)", () => {
    let state = baseRun();
    const key = buildDispatchKey("munichdeveloper/Immogent", "REQ-014", sha("1"));
    const prepared: SpecDispatchRecord = {
      dispatchKey: key, requirementId: "REQ-014", sourceSha: sha("1"),
      repository: "munichdeveloper/Immogent", requirementPath: "docs/requirements/REQ-014.md",
      targetSpecPath: "docs/specifications/SPEC-014.md", agentBranch: "harness/spec-gen-req-014",
      provider: "github-copilot", status: "prepared", dispatchedAt: "2026-08-24T10:00:00Z",
    };
    state = upsertSpecDispatch(state, prepared);
    const dispatched = { ...prepared, status: "dispatched" as const };
    state = upsertSpecDispatch(state, dispatched);
    expect(findSpecDispatch(state, key)?.status).toBe("dispatched");
  });

  it("rejects a backward status transition (pr-merged → dispatched)", () => {
    let state = baseRun();
    const key = buildDispatchKey("munichdeveloper/Immogent", "REQ-014", sha("1"));
    const merged: SpecDispatchRecord = {
      dispatchKey: key, requirementId: "REQ-014", sourceSha: sha("1"),
      repository: "munichdeveloper/Immogent", requirementPath: "docs/requirements/REQ-014.md",
      targetSpecPath: "docs/specifications/SPEC-014.md", agentBranch: "harness/spec-gen-req-014",
      provider: "github-copilot", status: "pr-merged", dispatchedAt: "2026-08-24T10:00:00Z",
    };
    state = upsertSpecDispatch(state, merged);
    const stale = { ...merged, status: "dispatched" as const };
    expect(() => upsertSpecDispatch(state, stale)).toThrow(/status downgrade/);
  });

  it("allows same-status upsert (idempotent)", () => {
    let state = baseRun();
    const key = buildDispatchKey("munichdeveloper/Immogent", "REQ-014", sha("1"));
    const record: SpecDispatchRecord = {
      dispatchKey: key, requirementId: "REQ-014", sourceSha: sha("1"),
      repository: "munichdeveloper/Immogent", requirementPath: "docs/requirements/REQ-014.md",
      targetSpecPath: "docs/specifications/SPEC-014.md", agentBranch: "harness/spec-gen-req-014",
      provider: "github-copilot", status: "dispatched", dispatchedAt: "2026-08-24T10:00:00Z",
    };
    state = upsertSpecDispatch(state, record);
    state = upsertSpecDispatch(state, record);
    expect(findSpecDispatch(state, key)?.status).toBe("dispatched");
  });
});

describe("SPEC-015: mergedBy actor validation", () => {
  it("rejects a Bot actor by type", () => {
    const headSha = sha("a");
    const state = bindDeliveryPullRequest(baseRun("merge-is-approval"), 42, headSha);
    expect(() =>
      recordDeliveryMergeEffect(state, {
        pullRequest: 42,
        approvedHeadSha: headSha,
        mergeCommitSha: sha("b"),
        mergedAt: "2026-08-24T10:00:00Z",
        mergedBy: "auto-merge-bot",
        mergedByType: "Bot",
      }),
    ).toThrow(/non-human actor/);
  });

  it("rejects a login ending in [bot] even without explicit type", () => {
    const headSha = sha("a");
    const state = bindDeliveryPullRequest(baseRun("merge-is-approval"), 42, headSha);
    expect(() =>
      recordDeliveryMergeEffect(state, {
        pullRequest: 42,
        approvedHeadSha: headSha,
        mergeCommitSha: sha("b"),
        mergedAt: "2026-08-24T10:00:00Z",
        mergedBy: "github-actions[bot]",
      }),
    ).toThrow(/non-human actor/);
  });

  it("accepts a User actor and records the login in the gate decision", () => {
    const headSha = sha("a");
    let state = bindDeliveryPullRequest(baseRun("merge-is-approval"), 42, headSha);
    state = recordDeliveryMergeEffect(state, {
      pullRequest: 42,
      approvedHeadSha: headSha,
      mergeCommitSha: sha("b"),
      mergedAt: "2026-08-24T10:00:00Z",
      mergedBy: "alice",
      mergedByType: "User",
    });
    const gate = state.gates.find((g) => isMergeApprovalGate(g));
    expect(gate?.decision?.by).toBe("alice");
  });

  it("rejects an empty mergedBy login", () => {
    const headSha = sha("a");
    const state = bindDeliveryPullRequest(baseRun("merge-is-approval"), 42, headSha);
    expect(() =>
      recordDeliveryMergeEffect(state, {
        pullRequest: 42,
        approvedHeadSha: headSha,
        mergeCommitSha: sha("b"),
        mergedAt: "2026-08-24T10:00:00Z",
        mergedBy: "",
      }),
    ).toThrow(/non-empty mergedBy login/);
  });
});

describe("SPEC-015: needsDeliveryMergeReconciliation for merge-is-approval runs", () => {
  it("returns true for a bound merge-is-approval run awaiting merge (no gate needed)", () => {
    const state = bindDeliveryPullRequest(baseRun("merge-is-approval"), 42, sha("a"));
    // No gate required — reconciler should poll to detect the merge event.
    expect(needsDeliveryMergeReconciliation(state)).toBe(true);
  });

  it("returns false once merge evidence is persisted", () => {
    const headSha = sha("a");
    let state = bindDeliveryPullRequest(baseRun("merge-is-approval"), 42, headSha);
    state = recordDeliveryMergeEffect(state, {
      pullRequest: 42,
      approvedHeadSha: headSha,
      mergeCommitSha: sha("b"),
      mergedAt: "2026-08-24T10:00:00Z",
      mergedBy: "alice",
    });
    expect(needsDeliveryMergeReconciliation(state)).toBe(false);
  });

  it("still requires a pre-existing gate for label-authorizes-auto-merge runs", () => {
    let state = bindDeliveryPullRequest(
      initRunState({ ...{ runId: "r", repository: "o/r", requirement: "REQ-001", spec: "SPEC-001" }, prApprovalPolicy: "label-authorizes-auto-merge" }),
      42, sha("a"),
    );
    expect(needsDeliveryMergeReconciliation(state)).toBe(false);
    state = upsertGate(state, { id: "delivery-merge-approval", type: "human", question: "Merge?" });
    state = resolveGate(state, "delivery-merge-approval", { result: "passed", decision: { approved: true, by: "alice", at: "2026-08-24T10:00:00Z" } });
    expect(needsDeliveryMergeReconciliation(state)).toBe(true);
  });
});
