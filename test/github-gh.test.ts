import { describe, expect, it } from "vitest";
import {
  buildMergePullRequestArgs,
  parsePaginatedIssues,
  parsePaginatedLabelEvents,
} from "../src/github/gh.js";

describe("GitHub pull-request merge command", () => {
  it("uses the supported CLI flags and binds the merge to the reviewed head", () => {
    expect(buildMergePullRequestArgs("owner/repo", 90, "merge", "abc123")).toEqual([
      "pr", "merge", "90",
      "--repo", "owner/repo",
      "--merge",
      "--match-head-commit", "abc123",
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
