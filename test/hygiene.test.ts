import { describe, expect, it } from "vitest";
import { checkHygiene } from "../src/state/hygiene.js";

describe("hygiene", () => {
  it("passes clean state", () => {
    expect(checkHygiene({ runId: "x", repository: "a/b", notes: ["fine"] })).toHaveLength(0);
  });

  it("flags a GitHub-token-shaped string anywhere in the tree", () => {
    const violations = checkHygiene({ notes: ["token is ghp_abcdefghijklmnopqrstuvwxyz0123456789"] });
    expect(violations.length).toBeGreaterThan(0);
  });

  it("flags credential-shaped field names even with an innocuous value", () => {
    const violations = checkHygiene({ apiKey: "whatever" });
    expect(violations.some((v) => v.path === "$.apiKey")).toBe(true);
  });
});
