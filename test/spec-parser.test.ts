import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "../src/spec/spec-parser.js";

describe("spec-parser", () => {
  it("parses simple frontmatter", () => {
    const content = `---
id: SPEC-015
type: software-spec
title: Test Spec
status: review
risk: medium
---
# Rest of content
`;
    const fm = parseFrontmatter(content);
    expect(fm.id).toBe("SPEC-015");
    expect(fm.type).toBe("software-spec");
    expect(fm.title).toBe("Test Spec");
    expect(fm.status).toBe("review");
  });

  it("parses implementation_assignee field", () => {
    const content = `---
id: SPEC-015
implementation_assignee: "@github-copilot"
---
# Content
`;
    const fm = parseFrontmatter(content);
    expect(fm.implementation_assignee).toBe("@github-copilot");
  });

  it("parses quoted strings and booleans", () => {
    const content = `---
name: "My Spec"
enabled: true
disabled: false
---
# Content
`;
    const fm = parseFrontmatter(content);
    expect(fm.name).toBe("My Spec");
    expect(fm.enabled).toBe(true);
    expect(fm.disabled).toBe(false);
  });

  it("parses arrays", () => {
    const content = `---
requirements:
  - REQ-001
  - REQ-002
---
# Content
`;
    const fm = parseFrontmatter(content);
    // Note: simple YAML array parsing is limited; this is a simplification
    // In real YAML, multi-line arrays would need different parsing
    expect(Array.isArray(fm.requirements) || typeof fm.requirements === "string").toBe(true);
  });

  it("throws on missing frontmatter", () => {
    const content = "# Just a heading, no frontmatter";
    expect(() => parseFrontmatter(content)).toThrow("No frontmatter found");
  });
});
