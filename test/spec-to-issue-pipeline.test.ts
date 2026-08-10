import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findIssuesByTitleContains = vi.fn();
const createIssue = vi.fn();

vi.mock("../src/github/gh.js", () => ({
  github: {
    findIssuesByTitleContains: (...args: unknown[]) => findIssuesByTitleContains(...args),
    createIssue: (...args: unknown[]) => createIssue(...args),
  },
}));

const { runSpecToIssuePipeline } = await import("../src/spec/spec-to-issue-pipeline.js");

const APPROVED_SPEC = `---
id: SPEC-051
type: software-spec
title: Reaktiver Pipeline-Test
status: approved
requirements:
  - REQ-051
---

# SPEC-051: Reaktiver Pipeline-Test
`;

const DRAFT_SPEC = APPROVED_SPEC.replace("status: approved", "status: draft");

describe("runSpecToIssuePipeline (SPEC-007 reactive spec-to-issue entrypoint)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spec-to-issue-"));
    findIssuesByTitleContains.mockReset();
    createIssue.mockReset();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("TAC-04: creates exactly one issue for an approved spec with no prior match", async () => {
    findIssuesByTitleContains.mockResolvedValue([]);
    createIssue.mockResolvedValue({ repository: "acme/widgets", number: 7, url: "https://github.com/acme/widgets/issues/7" });

    const specPath = join(dir, "SPEC-051.md");
    await writeFile(specPath, APPROVED_SPEC, "utf-8");

    const result = await runSpecToIssuePipeline({ repository: "acme/widgets", specPath });

    expect(result.action).toBe("created");
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue).toHaveBeenCalledWith(
      "acme/widgets",
      expect.objectContaining({ title: "SPEC-051: Reaktiver Pipeline-Test" }),
    );
  });

  it("TAC-05: does not create an issue for status: draft", async () => {
    const specPath = join(dir, "SPEC-051.md");
    await writeFile(specPath, DRAFT_SPEC, "utf-8");

    const result = await runSpecToIssuePipeline({ repository: "acme/widgets", specPath });

    expect(result.action).toBe("skipped-not-approved");
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("TAC-06/TAC-07: does not create a second issue when one already exists for the spec-id (regardless of origin)", async () => {
    findIssuesByTitleContains.mockResolvedValue([
      { repository: "acme/widgets", number: 3, url: "https://github.com/acme/widgets/issues/3" },
    ]);

    const specPath = join(dir, "SPEC-051.md");
    await writeFile(specPath, APPROVED_SPEC, "utf-8");

    const result = await runSpecToIssuePipeline({ repository: "acme/widgets", specPath });

    expect(result.action).toBe("skipped-duplicate");
    expect(result).toMatchObject({ existingIssue: { number: 3 } });
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("searches broadly by spec-id in title (AC-04/TAC-06/TAC-07 cross-path idempotency)", async () => {
    findIssuesByTitleContains.mockResolvedValue([]);
    createIssue.mockResolvedValue({ repository: "acme/widgets", number: 9, url: "https://github.com/acme/widgets/issues/9" });

    const specPath = join(dir, "SPEC-051.md");
    await writeFile(specPath, APPROVED_SPEC, "utf-8");

    await runSpecToIssuePipeline({ repository: "acme/widgets", specPath });

    expect(findIssuesByTitleContains).toHaveBeenCalledWith("acme/widgets", "SPEC-051");
  });

  it("AC-08: never includes execution labels (status:ready/ai:allowed) on the created issue", async () => {
    findIssuesByTitleContains.mockResolvedValue([]);
    createIssue.mockResolvedValue({ repository: "acme/widgets", number: 11, url: "https://github.com/acme/widgets/issues/11" });

    const specPath = join(dir, "SPEC-051.md");
    await writeFile(specPath, APPROVED_SPEC, "utf-8");

    await runSpecToIssuePipeline({ repository: "acme/widgets", specPath });

    const callArgs = createIssue.mock.calls[0][1] as { labels?: string[] };
    expect(callArgs.labels ?? []).not.toContain("status:ready");
    expect(callArgs.labels ?? []).not.toContain("ai:allowed");
  });
});
