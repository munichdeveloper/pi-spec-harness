import { describe, expect, it } from "vitest";
import {
  buildMergePullRequestArgs,
  findBlockingStatusChecks,
  parsePaginatedIssues,
  parsePaginatedLabelEvents,
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
