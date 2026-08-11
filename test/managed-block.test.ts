import { describe, expect, it } from "vitest";
import {
  AGENTS_MD_PATH,
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  renderHarnessContextBlock,
  upsertManagedBlock,
} from "../src/agents-context/managed-block.js";
import { IMMOGENT_AGENTS_MD_FIXTURE } from "./fixtures/immogent-agents-md.fixture.js";

const block = renderHarnessContextBlock({ repository: "munichdeveloper/Immogent" });

describe("AGENTS_MD_PATH / renderHarnessContextBlock", () => {
  it("targets AGENTS.md at the repository root", () => {
    expect(AGENTS_MD_PATH).toBe("AGENTS.md");
  });

  it("TAC-09: contains the required minimum content -- tracking-issue hint, label table, docs link", () => {
    expect(block).toContain(MANAGED_BLOCK_BEGIN);
    expect(block).toContain(MANAGED_BLOCK_END);
    expect(block).toContain("[Harness Run]");
    expect(block).toContain("harness:run");
    expect(block).toContain("Tracking-Issue");
    expect(block).toContain("| `ai:allowed` |");
    expect(block).toContain("| `status:ready` |");
    expect(block).toContain("| `status:needs-human` |");
    expect(block).toContain("| `harness:implementation` |");
    expect(block).toContain("harness:gate-approved");
    expect(block).toContain("harness:gate-rejected");
    expect(block).toContain("docs/human-gates.md");
    expect(block).toContain("docs/event-driven-workflow.md");
  });
});

describe("upsertManagedBlock (SPEC-008 5-way decision)", () => {
  it("TAC-01: create -- undefined existing content yields a file consisting solely of the block", () => {
    const result = upsertManagedBlock(undefined, block);
    expect(result.decision).toBe("create");
    expect(result.content).toBe(block);
  });

  it("TAC-02: insert-appended -- realistic foreign AGENTS.md keeps every existing section byte-identical, block appended", () => {
    const result = upsertManagedBlock(IMMOGENT_AGENTS_MD_FIXTURE, block);
    expect(result.decision).toBe("insert-appended");

    for (const heading of [
      "## Quellen der Wahrheit",
      "## Vor jeder Implementierung",
      "## Implementierung",
      "## Verifikation",
      "## Definition of Done",
    ]) {
      expect(result.content).toContain(heading);
    }
    // The entire original fixture must appear byte-identical as a prefix.
    expect(result.content.startsWith(IMMOGENT_AGENTS_MD_FIXTURE)).toBe(true);
    // The block appears once, at the end.
    expect(result.content.endsWith(block)).toBe(true);
    expect(result.content.split(MANAGED_BLOCK_BEGIN)).toHaveLength(2);
  });

  it("TAC-03: update-managed -- existing stale block content is replaced, content outside markers stays byte-identical", () => {
    const before = "# Foo\n\nSome prose.\n\n";
    const after = "\n\nMore prose after.\n";
    const staleBlock = `${MANAGED_BLOCK_BEGIN}\nSTALE CONTENT\n${MANAGED_BLOCK_END}`;
    const existing = `${before}${staleBlock}${after}`;

    const result = upsertManagedBlock(existing, block);

    expect(result.decision).toBe("update-managed");
    expect(result.content).toBe(`${before}${block}${after}`);
    expect(result.content).toContain(before.trim());
    expect(result.content).toContain(after.trim());
    expect(result.content).not.toContain("STALE CONTENT");
  });

  it("TAC-04: noop -- identical, already-current block content is left unchanged", () => {
    const existing = `# Foo\n\n${block}\n`;
    const result = upsertManagedBlock(existing, block);
    expect(result.decision).toBe("noop");
    expect(result.content).toBe(existing);
  });

  it("TAC-05: conflict -- only the begin marker is present, no write is applied", () => {
    const existing = `# Foo\n\n${MANAGED_BLOCK_BEGIN}\nOrphaned begin marker, no end marker.\n`;
    const result = upsertManagedBlock(existing, block);
    expect(result.decision).toBe("conflict");
    expect(result.content).toBe(existing);
  });

  it("TAC-05: conflict -- only the end marker is present, no write is applied", () => {
    const existing = `# Foo\n\nOrphaned end marker below.\n${MANAGED_BLOCK_END}\n`;
    const result = upsertManagedBlock(existing, block);
    expect(result.decision).toBe("conflict");
    expect(result.content).toBe(existing);
  });

  it("TAC-07: idempotent -- applying the noop result again still yields noop", () => {
    const first = upsertManagedBlock(IMMOGENT_AGENTS_MD_FIXTURE, block);
    expect(first.decision).toBe("insert-appended");
    const second = upsertManagedBlock(first.content, block);
    expect(second.decision).toBe("noop");
    expect(second.content).toBe(first.content);
  });

  it("separates an appended block from prior content with a blank line", () => {
    const existing = "# Foo\nLast line, no trailing blank line.";
    const result = upsertManagedBlock(existing, block);
    expect(result.content).toBe(`${existing}\n\n${block}`);
  });
});
