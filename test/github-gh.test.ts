import { describe, expect, it } from "vitest";
import {
  buildMergePullRequestArgs,
  findBlockingStatusChecks,
  parsePaginatedIssues,
  parsePaginatedLabelEvents,
  selectPullRequestByBodyMarker,
  selectPullRequestByClosingIssue,
} from "../src/github/gh.js";

describe("GitHub pull-request merge command", () => {
  it("uses the supported CLI flags and binds the merge to the reviewed head", () => {
    expect(buildMergePullRequestArgs("owner/repo", "delivery/spec-014", "abc123")).toEqual([
      "api",
      "repos/owner/repo/merges",
      "--method", "POST",
      "-f", "base=delivery/spec-014",
      "-f", "head=abc123",
    ]);
  });
});

describe("GitHub coding-agent pull-request discovery", () => {
  const candidate = (number: number, body: string) => ({
    number,
    body,
    headRefOid: `head-${number}`,
    headRefName: `copilot/normalized-${number}`,
    state: "OPEN",
    mergedAt: null,
    mergeCommit: null,
    url: `https://example.test/pull/${number}`,
  });

  it("binds a normalized agent branch through the immutable dispatch marker", () => {
    expect(selectPullRequestByBodyMarker([
      candidate(41, "Fixes #40\n<!-- dispatch:req-025:abc -->"),
    ], "dispatch:req-025:abc")?.number).toBe(41);
  });

  it("fails closed when a marker is ambiguous", () => {
    expect(() => selectPullRequestByBodyMarker([
      candidate(41, "dispatch:req-025:abc"),
      candidate(42, "dispatch:req-025:abc"),
    ], "dispatch:req-025:abc")).toThrow("multiple pull requests");
  });

  it("binds an agent PR through its unique closing reference to the dispatch issue", () => {
    expect(selectPullRequestByClosingIssue([
      candidate(41, "Implementation complete.\n\nFixes #40"),
    ], 40)?.number).toBe(41);
  });

  it("does not accept an unrelated numeric mention as closing evidence", () => {
    expect(selectPullRequestByClosingIssue([
      candidate(41, "Related to #40"),
    ], 40)).toBeUndefined();
  });

  it("fails closed when multiple PRs close the same dispatch issue", () => {
    expect(() => selectPullRequestByClosingIssue([
      candidate(41, "Fixes #40"),
      candidate(42, "Resolves: #40"),
    ], 40)).toThrow("multiple pull requests close dispatch issue");
  });
});

describe("GitHub status-check rollup", () => {
  it("accepts successful and intentionally skipped completed checks", () => {
    expect(findBlockingStatusChecks([
      { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "optional", status: "COMPLETED", conclusion: "SKIPPED" },
      { __typename: "StatusContext", context: "security", state: "SUCCESS" },
    ])).toEqual([]);
  });

  it("fails closed for pending, failed, and unknown checks", () => {
    expect(findBlockingStatusChecks([
      { __typename: "CheckRun", name: "ci", status: "IN_PROGRESS", conclusion: "" },
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "StatusContext", context: "security", state: "PENDING" },
      {},
    ])).toEqual([
      "ci: IN_PROGRESS",
      "lint: FAILURE",
      "security: PENDING",
      "unnamed-check: UNKNOWN",
    ]);
  });
});

describe("GitHub pagination parsing", () => {
  it("flattens all timeline pages and sorts label events chronologically", () => {
    const output = JSON.stringify([
      [
        { event: "labeled", label: { name: "approved" }, actor: { login: "later" }, created_at: "2026-08-03T10:00:02Z" },
        { event: "commented", actor: { login: "ignored" }, created_at: "2026-08-03T10:00:00Z" },
      ],
      [
        { event: "labeled", label: { name: "rejected" }, actor: { login: "earlier" }, created_at: "2026-08-03T10:00:01Z" },
      ],
    ]);

    expect(parsePaginatedLabelEvents(output)).toEqual([
      { label: "rejected", actor: "earlier", createdAt: "2026-08-03T10:00:01Z" },
      { label: "approved", actor: "later", createdAt: "2026-08-03T10:00:02Z" },
    ]);
  });

  it("returns issues from every page, excludes pull requests, and normalizes null bodies", () => {
    const output = JSON.stringify([
      [{ number: 1, title: "first", body: "state" }],
      [
        { number: 2, title: "pull request", body: "diff", pull_request: { url: "https://example.test" } },
        { number: 3, title: "third", body: null },
      ],
    ]);

    expect(parsePaginatedIssues(output)).toEqual([
      { number: 1, title: "first", body: "state" },
      { number: 3, title: "third", body: "" },
    ]);
  });
});
