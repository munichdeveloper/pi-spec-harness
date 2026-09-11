import { describe, expect, it } from "vitest";
import { classifyIssueIntake } from "../scripts/issue_intake_classifier.mjs";

describe("SPEC-017 issue intake classifier", () => {
  it.each(["Gewünschte Anpassung", "Gewuenschte Anpassung", "Ziel"]) (
    "recognizes a structured requirement with the %s heading",
    (heading) => {
      expect(classifyIssueIntake("Blogbeitrag breiter darstellen", `## Problem\nDer Text ist zu schmal.\n\n## ${heading}\nMehr nutzbare Breite.\n\n## Akzeptanzkriterien\n- Kein Overflow.`)).toEqual({
        kind: "requirement",
        label: "type:requirement",
      });
    },
  );

  it("does not treat unwanted behavior or target-path words as an explicit outcome heading", () => {
    expect(classifyIssueIntake("Layout prüfen", "## Kontext\nUnerwünschte Abstände im Zielrepository.\n\n## Akzeptanzkriterien\n- Kein Overflow.")).toEqual({
      kind: "incomplete",
      label: "intake:needs-information",
    });
  });

  it("keeps incomplete free text incomplete", () => {
    expect(classifyIssueIntake("Blogbeitrag", "Bitte einmal ansehen.")).toEqual({
      kind: "incomplete",
      label: "intake:needs-information",
    });
  });
});
