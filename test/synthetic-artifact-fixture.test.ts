import { describe, expect, it } from "vitest";
import { prepareSyntheticArtifactFixture } from "../src/spec/synthetic-artifact-fixture.js";

const artifact = { specRevision: "a".repeat(40), verdict: "passed", evidence: ["https://example.test"] };

describe("synthetic stale artifact fixture", () => {
  it.each([undefined, "", "false"])("is inert when enabled is %s", (enabled) => {
    expect(prepareSyntheticArtifactFixture(artifact, { enabled })).toBe(artifact);
  });

  it("changes only the copied spec revision under exact synthetic Harness activation", () => {
    const prepared = prepareSyntheticArtifactFixture(artifact, {
      enabled: "true",
      synthetic: "true",
      repository: "munichdeveloper/pi-spec-harness",
    });
    expect(prepared).toEqual({ ...artifact, specRevision: "f".repeat(40) });
    expect(prepared).not.toBe(artifact);
    expect(artifact.specRevision).toBe("a".repeat(40));
  });

  it("keeps the stale replacement different when the input is all f", () => {
    expect(
      prepareSyntheticArtifactFixture(
        { ...artifact, specRevision: "f".repeat(40) },
        { enabled: "true", synthetic: "true", repository: "munichdeveloper/pi-spec-harness" },
      ).specRevision,
    ).toBe("e".repeat(40));
  });

  it.each([
    { enabled: "true", synthetic: "false", repository: "munichdeveloper/pi-spec-harness" },
    { enabled: "true", synthetic: "true", repository: "munichdeveloper/Immogent" },
    { enabled: "yes", synthetic: "true", repository: "munichdeveloper/pi-spec-harness" },
  ])("fails closed for invalid activation $enabled/$synthetic/$repository", (context) => {
    expect(() => prepareSyntheticArtifactFixture(artifact, context)).toThrow(
      "Stale artifact fixture requires explicit synthetic Harness activation",
    );
  });

  it("rejects malformed input revisions", () => {
    expect(() =>
      prepareSyntheticArtifactFixture(
        { ...artifact, specRevision: "invalid" },
        { enabled: "true", synthetic: "true", repository: "munichdeveloper/pi-spec-harness" },
      ),
    ).toThrow("Invalid synthetic artifact revision");
  });
});
