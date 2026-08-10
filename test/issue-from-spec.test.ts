import { describe, expect, it } from "vitest";
import { buildIssueFromSpec, IssueFromSpecError, parseSpecFrontmatterForIssue } from "../src/spec/issue-from-spec.js";

// TAC-01: frozen, realistic sample spec (shape equivalent to a real approved
// pi-spec-harness/Immogent spec) used as the migration-regression fixture
// for buildIssueFromSpec()'s title/body format.
const APPROVED_SPEC = `---
id: SPEC-042
type: software-spec
title: Beispiel-Feature für Regressionstest
status: approved
owner: engineering
risk: medium
requirements:
  - REQ-042
  - REQ-043
created: 2026-01-01
updated: 2026-01-02
---

# SPEC-042: Beispiel-Feature für Regressionstest

## Zusammenfassung

Kurze Zusammenfassung des Beispiel-Features.

## Technische Akzeptanzkriterien

- TAC-01: Beispielkriterium eins.
- TAC-02: Beispielkriterium zwei.

## Zerlegung in Issues

- Teil 1: Backend-Änderung
- Teil 2: Frontend-Änderung

## Rollback

Additiv, kein Rollback nötig.
`;

const DRAFT_SPEC = APPROVED_SPEC.replace("status: approved", "status: draft");
const REVIEW_SPEC = APPROVED_SPEC.replace("status: approved", "status: review");

const SPEC_WITHOUT_REQUIREMENTS = `---
id: SPEC-043
type: software-spec
title: Spec ohne Requirements
status: approved
---

# SPEC-043: Spec ohne Requirements
`;

const SPEC_WITHOUT_BREAKDOWN = `---
id: SPEC-044
type: software-spec
title: Spec ohne Zerlegung
status: approved
requirements:
  - REQ-044
---

# SPEC-044: Spec ohne Zerlegung

## Zusammenfassung

Keine Zerlegung-in-Issues-Sektion vorhanden.
`;

describe("parseSpecFrontmatterForIssue", () => {
  it("parses multi-line YAML list requirements (unlike the generic parseFrontmatter)", () => {
    const fm = parseSpecFrontmatterForIssue(APPROVED_SPEC);
    expect(fm.id).toBe("SPEC-042");
    expect(fm.title).toBe("Beispiel-Feature für Regressionstest");
    expect(fm.status).toBe("approved");
    expect(fm.requirements).toEqual(["REQ-042", "REQ-043"]);
  });
});

describe("buildIssueFromSpec (SPEC-007 TAC-01/TAC-02)", () => {
  it("TAC-01: builds the title as '<SPEC-ID>: <Titel>' and a body with requirements, breakdown, and Definition of Ready", () => {
    const result = buildIssueFromSpec(APPROVED_SPEC, { specPath: "docs/specifications/SPEC-042-example.md" });

    expect(result.title).toBe("SPEC-042: Beispiel-Feature für Regressionstest");
    expect(result.body).toContain("SPEC-042");
    expect(result.body).toContain("docs/specifications/SPEC-042-example.md");
    expect(result.body).toContain("REQ-042");
    expect(result.body).toContain("REQ-043");
    expect(result.body).toContain("## Requirements");
    expect(result.body).toContain("- REQ-042");
    expect(result.body).toContain("- REQ-043");
    expect(result.body).toContain("## Zerlegung in Issues");
    expect(result.body).toContain("Teil 1: Backend-Änderung");
    expect(result.body).toContain("Teil 2: Frontend-Änderung");
    expect(result.body).toContain("## Definition of Ready");
  });

  it("is a pure, deterministic function: identical input yields byte-identical output", () => {
    const first = buildIssueFromSpec(APPROVED_SPEC);
    const second = buildIssueFromSpec(APPROVED_SPEC);
    expect(first).toEqual(second);
  });

  it("omits the 'Zerlegung in Issues' section when the spec has none", () => {
    const result = buildIssueFromSpec(SPEC_WITHOUT_BREAKDOWN);
    expect(result.body).not.toContain("Zerlegung in Issues");
    expect(result.body).toContain("## Definition of Ready");
  });

  it("TAC-02: throws a typed IssueFromSpecError for status: draft without returning a partial result", () => {
    expect(() => buildIssueFromSpec(DRAFT_SPEC)).toThrow(IssueFromSpecError);
    expect(() => buildIssueFromSpec(DRAFT_SPEC)).toThrow(/status: approved/);
  });

  it("TAC-02: throws a typed IssueFromSpecError for status: review", () => {
    expect(() => buildIssueFromSpec(REVIEW_SPEC)).toThrow(IssueFromSpecError);
  });

  it("TAC-02: throws a typed IssueFromSpecError for missing/empty requirements[]", () => {
    expect(() => buildIssueFromSpec(SPEC_WITHOUT_REQUIREMENTS)).toThrow(IssueFromSpecError);
    expect(() => buildIssueFromSpec(SPEC_WITHOUT_REQUIREMENTS)).toThrow(/requirements/);
  });

  it("throws IssueFromSpecError (not a generic Error) for content without any frontmatter", () => {
    expect(() => buildIssueFromSpec("# No frontmatter here")).toThrow(IssueFromSpecError);
  });
});
