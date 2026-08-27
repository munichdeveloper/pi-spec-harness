import { describe, expect, it } from "vitest";
import { evaluateReadiness, isReadinessContract, type ReadinessBlocker, type VerifiedSpikeEvidence } from "../src/spec/readiness.js";

const blocker: ReadinessBlocker = { id: "coordinates", stage: "implementation", kind: "technical", owner: "research", question: "Are coordinates available?", criteria: ["source", "reproduction"], maxAttempts: 2 };
const evidence: VerifiedSpikeEvidence = { blockerId: blocker.id, specRevision: "revision-a", verdict: "passed", verifiedCriteria: [...blocker.criteria], references: ["https://example.org/evidence"], changes: [] };
function fixture() {
  return {
    approved: true, revision: "revision-a",
    contract: { schemaVersion: 1 as const, specRevision: "revision-a", blockers: [structuredClone(blocker)] },
    evidence: [] as VerifiedSpikeEvidence[], attempts: {} as Record<string, number>, costCeiling: 0,
    executors: [{ id: "configured-agent", authorized: true, available: true, capabilities: ["spike", "implementation"] as Array<"spike" | "implementation">, maxTaskCost: 0 }],
  };
}

describe("SPEC-016 pure readiness decisions", () => {
  it("never treats business approval as readiness classification", () => {
    expect(evaluateReadiness({ ...fixture(), contract: undefined }).action).toBe("classify");
    expect(evaluateReadiness({ ...fixture(), approved: false }).action).toBe("await-approval");
    expect(evaluateReadiness({ ...fixture(), revision: "revision-b" }).action).toBe("classify");
  });
  it("selects bounded technical work before implementation", () => {
    expect(evaluateReadiness(fixture())).toMatchObject({ action: "spike", blockerId: "coordinates", executorId: "configured-agent" });
  });
  it("resumes automatically only with complete revision-bound evidence", () => {
    expect(evaluateReadiness({ ...fixture(), evidence: [evidence] }).action).toBe("implement");
    for (const incomplete of [{ ...evidence, references: [] }, { ...evidence, verifiedCriteria: ["source"] }, { ...evidence, specRevision: "old" }, { ...evidence, verdict: "failed" as const }]) {
      expect(evaluateReadiness({ ...fixture(), evidence: [incomplete] }).action).toBe("spike");
    }
  });
  it("does not let deployment or deferred questions block implementation", () => {
    for (const stage of ["deployment", "deferred"] as const) {
      const input = fixture(); input.contract.blockers[0].stage = stage;
      expect(evaluateReadiness(input).action).toBe("implement");
    }
  });
  it("escalates boundary changes and ambiguous evidence", () => {
    for (const change of ["scope", "cost", "privacy"] as const) {
      expect(evaluateReadiness({ ...fixture(), evidence: [{ ...evidence, changes: [change] }] }).action).toBe("human-decision");
    }
    expect(evaluateReadiness({ ...fixture(), evidence: [evidence, evidence] }).action).toBe("human-decision");
  });
  it("does not bypass product decisions or exhausted retry budgets", () => {
    const input = fixture(); input.contract.blockers[0].kind = "decision";
    expect(evaluateReadiness({ ...input, evidence: [evidence] }).action).toBe("human-decision");
    for (const attempts of [2, 3, -1, NaN]) {
      expect(evaluateReadiness({ ...fixture(), attempts: { coordinates: attempts } }).action).toBe("human-decision");
    }
  });
  it("rejects unauthorized, unavailable, costly or unsupported execution", () => {
    for (const override of [{ authorized: false }, { available: false }, { maxTaskCost: 1 }, { maxTaskCost: NaN }, { capabilities: [] }]) {
      const input = fixture(); Object.assign(input.executors[0], override);
      expect(evaluateReadiness(input).action).toBe("await-executor");
    }
    const input = fixture(); input.executors.push(structuredClone(input.executors[0]));
    expect(evaluateReadiness(input).reason).toBe("ambiguous-executor-policy");
  });
  it("rejects malformed and duplicate blocker definitions", () => {
    expect(isReadinessContract({})).toBe(false);
    for (const override of [{ owner: "" }, { criteria: [] }, { maxAttempts: 0 }, { stage: "unknown" }]) {
      expect(isReadinessContract({ ...fixture().contract, blockers: [{ ...blocker, ...override }] })).toBe(false);
    }
    expect(isReadinessContract({ ...fixture().contract, blockers: [blocker, blocker] })).toBe(false);
  });
});
