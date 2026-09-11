import { describe, expect, it } from "vitest";
import {
  buildRequirementMaterializationPlan,
  isApprovedRequirement,
  REQUIREMENT_MATERIALIZATION_MARKER,
} from "../src/intake/requirement-materialization.js";

const issue = {
  number: 25,
  title: "Blogbeitrag: Textbreite verbessern",
  body: "## Ziel\n\nMehr Breite.\n\n## Akzeptanzkriterien\n\n- Kein Overflow",
  url: "https://github.com/acme/site/issues/25",
  labels: [{ name: "type:requirement" }, { name: "harness:approved-for-agent" }],
};

describe("approved requirement materialization", () => {
  it("requires both classification and the single approval evidence", () => {
    expect(isApprovedRequirement(issue)).toBe(true);
    expect(isApprovedRequirement({ ...issue, labels: [{ name: "type:requirement" }] })).toBe(false);
  });

  it("builds deterministic versioned coordinates and preserves the source", () => {
    const plan = buildRequirementMaterializationPlan(issue);
    expect(plan.requirementId).toBe("REQ-025");
    expect(plan.requirementPath).toBe("docs/requirements/REQ-025.md");
    expect(plan.branch).toBe("harness/requirement-issue-25");
    expect(plan.content).toContain("status: approved");
    expect(plan.content).toContain(`${REQUIREMENT_MATERIALIZATION_MARKER}; source-issue=25`);
    expect(plan.content).toContain(issue.body);
    expect(plan.pullRequestBody).toContain("no second content approval is required");
  });

  it("rejects path traversal before creating a plan", () => {
    expect(() => buildRequirementMaterializationPlan(issue, "../requirements")).toThrow("invalid requirement output directory");
  });
});
