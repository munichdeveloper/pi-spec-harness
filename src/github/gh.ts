import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/**
 * Run a `gh` command and pipe `jsonBody` to its stdin (for APIs that require
 * a JSON request body, e.g. `gh api --input -`).
 */
async function runGhWithJson(args: string[], jsonBody: unknown): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const proc = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });
    proc.on("error", reject);
    proc.on("close", (code: number | null) => {
      if (code === 0) resolve(stdout);
      else reject(new GhError(`gh ${args.join(" ")} failed: ${stderr.trim()}`));
    });
    proc.stdin.write(JSON.stringify(jsonBody), "utf-8");
    proc.stdin.end();
  });
}

export class GhError extends Error {}

async function runGh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile("gh", args, { maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GhError(`gh ${args.join(" ")} failed: ${e.stderr ?? e.message}`);
  }
}

export interface IssueRef {
  repository: string;
  number: number;
  url: string;
}

export interface LabelEvent {
  label: string;
  actor: string;
  createdAt: string;
}

interface TimelineEvent {
  event: string;
  label?: { name: string };
  actor?: { login: string };
  created_at?: string;
}

interface ApiIssue {
  number: number;
  title: string;
  body: string | null;
  pull_request?: unknown;
}

/** Parse `gh api --paginate --slurp` timeline output deterministically. */
export function parsePaginatedLabelEvents(out: string): LabelEvent[] {
  const pages = JSON.parse(out) as TimelineEvent[][];
  return pages
    .flat()
    .filter((event) => event.event === "labeled" && event.label?.name && event.actor?.login && event.created_at)
    .map((event) => ({
      label: event.label!.name,
      actor: event.actor!.login,
      createdAt: event.created_at!,
    }))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** Parse all paginated issue results and exclude pull requests. */
export function parsePaginatedIssues(out: string): { number: number; title: string; body: string }[] {
  const pages = JSON.parse(out) as ApiIssue[][];
  return pages
    .flat()
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({ number: issue.number, title: issue.title, body: issue.body ?? "" }));
}

/**
 * Thin, explicit wrapper around the `gh` CLI. Every write action here is a
 * deliberate, named function -- there is no generic "run arbitrary gh
 * mutation" escape hatch, so every write the harness performs is auditable
 * from this one file.
 */
export const github = {
  async ensureLabel(
    repository: string,
    name: string,
    opts: { color?: string; description?: string } = {},
  ): Promise<void> {
    try {
      await runGh([
        "label", "create", name,
        "--repo", repository,
        "--color", opts.color ?? "5319E7",
        "--description", opts.description ?? "",
        "--force",
      ]);
    } catch (err) {
      // --force should make this idempotent; only swallow "already exists"-style races.
      if (!(err instanceof GhError) || !/already exists/i.test(err.message)) {
        throw err;
      }
    }
  },

  async viewIssue(repository: string, number: number) {
    const out = await runGh(["issue", "view", String(number), "--repo", repository, "--json",
      "number,title,body,state,labels,assignees,url,comments"]);
    return JSON.parse(out) as {
      number: number;
      title: string;
      body: string;
      state: string;
      labels: { name: string }[];
      assignees: { login: string }[];
      url: string;
      comments: { author: { login: string }; body: string; createdAt: string }[];
    };
  },

  async viewPullRequest(repository: string, number: number) {
    const out = await runGh(["pr", "view", String(number), "--repo", repository, "--json",
      "number,title,body,state,url,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,baseRefName,headRefName,mergedAt,mergeCommit"]);
    return JSON.parse(out) as Record<string, unknown>;
  },

  async createIssue(
    repository: string,
    opts: { title: string; body: string; labels?: string[] },
  ): Promise<IssueRef> {
    const args = ["issue", "create", "--repo", repository, "--title", opts.title, "--body", opts.body];
    for (const label of opts.labels ?? []) {
      args.push("--label", label);
    }
    const out = await runGh(args);
    const url = out.trim().split("\n").pop() ?? "";
    const match = url.match(/\/issues\/(\d+)/);
    const number = match ? Number(match[1]) : Number.NaN;
    return { repository, number, url };
  },

  async commentIssue(repository: string, number: number, body: string): Promise<void> {
    await runGh(["issue", "comment", String(number), "--repo", repository, "--body", body]);
  },

  async addLabels(repository: string, number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await runGh(["issue", "edit", String(number), "--repo", repository, ...labels.flatMap((l) => ["--add-label", l])]);
  },

  async removeLabels(repository: string, number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await runGh(["issue", "edit", String(number), "--repo", repository, ...labels.flatMap((l) => ["--remove-label", l])]);
  },

  async addAssignees(repository: string, number: number, assignees: string[]): Promise<void> {
    if (assignees.length === 0) return;
    await runGh(["issue", "edit", String(number), "--repo", repository, ...assignees.flatMap((a) => ["--add-assignee", a])]);
  },

  async closeIssue(repository: string, number: number, comment?: string): Promise<void> {
    const args = ["issue", "close", String(number), "--repo", repository];
    if (comment) args.push("--comment", comment);
    await runGh(args);
  },

  async updateIssueBody(repository: string, number: number, body: string): Promise<void> {
    await runGh(["issue", "edit", String(number), "--repo", repository, "--body", body]);
  },

  /**
   * Find an open-or-closed issue whose title matches exactly. Used to
   * find-or-create the single persistent tracking issue for a run.
   */
  async findIssueByExactTitle(repository: string, title: string): Promise<IssueRef | undefined> {
    const out = await runGh([
      "issue", "list", "--repo", repository, "--state", "all",
      "--search", `"${title}" in:title`,
      "--json", "number,title,url",
      "--limit", "20",
    ]);
    const issues = JSON.parse(out) as { number: number; title: string; url: string }[];
    const match = issues.find((i) => i.title === title);
    return match ? { repository, number: match.number, url: match.url } : undefined;
  },

  /**
   * Find an open-or-closed issue whose title *contains* the given query
   * (not an exact match). SPEC-007 TAC-04/TAC-06/TAC-07: used for the
   * spec-to-issue idempotency check, which intentionally searches broadly
   * "in:title" for the spec-id so both the reactive pipeline and a manually
   * created issue (via `harness issue-create --from-spec-path`) are found.
   */
  async findIssuesByTitleContains(repository: string, query: string): Promise<IssueRef[]> {
    const out = await runGh([
      "issue", "list", "--repo", repository, "--state", "all",
      "--search", `in:title "${query}"`,
      "--json", "number,title,url",
      "--limit", "20",
    ]);
    const issues = JSON.parse(out) as { number: number; title: string; url: string }[];
    return issues.map((issue) => ({ repository, number: issue.number, url: issue.url }));
  },

  async createPullRequest(
    repository: string,
    opts: { title: string; body: string; base: string; head: string; draft?: boolean },
  ): Promise<{ number: number; url: string }> {
    const args = [
      "pr", "create", "--repo", repository,
      "--title", opts.title, "--body", opts.body,
      "--base", opts.base, "--head", opts.head,
    ];
    if (opts.draft) args.push("--draft");
    const out = await runGh(args);
    const url = out.trim().split("\n").pop() ?? "";
    const match = url.match(/\/pull\/(\d+)/);
    const number = match ? Number(match[1]) : Number.NaN;
    return { number, url };
  },

  /**
   * Get the current HEAD commit SHA of a branch via the GitHub API.
   * TAC-02: used to verify the delivery branch remote-head before committing.
   */
  async getBranchSha(repository: string, branch: string): Promise<string> {
    const out = await runGh([
      "api",
      `repos/${repository}/git/refs/heads/${encodeURIComponent(branch)}`,
      "--jq", ".object.sha",
    ]);
    return out.trim();
  },

  /**
   * Fetch a file's raw content and its blob SHA from a specific ref.
   * Returns content as a UTF-8 string plus the blob SHA needed for updates.
   */
  async getFileContent(
    repository: string,
    path: string,
    ref: string,
  ): Promise<{ content: string; blobSha: string }> {
    const out = await runGh([
      "api",
      `repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    ]);
    const data = JSON.parse(out) as { content: string; sha: string };
    const content = Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf-8");
    return { content, blobSha: data.sha };
  },

  /**
   * Fetch a file from a repository when it may not exist. Returns undefined
   * on 404 so callers can implement idempotent install/update flows.
   */
  async getFileContentIfExists(
    repository: string,
    path: string,
    ref?: string,
  ): Promise<{ content: string; blobSha: string } | undefined> {
    const endpoint = ref
      ? `repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`
      : `repos/${repository}/contents/${path}`;
    try {
      const out = await runGh(["api", endpoint]);
      const data = JSON.parse(out) as { content: string; sha: string };
      const content = Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf-8");
      return { content, blobSha: data.sha };
    } catch (err) {
      if (err instanceof GhError && /404|not found/i.test(err.message)) return undefined;
      throw err;
    }
  },

  /**
   * Commit a single file update on a branch via the GitHub Contents API.
   * Returns the new commit SHA.
   * TAC-03: used to commit spec-approval status exclusively on the delivery branch.
   */
  async updateFileOnBranch(
    repository: string,
    branch: string,
    path: string,
    newContent: string,
    currentBlobSha: string,
    commitMessage: string,
  ): Promise<string> {
    const encodedContent = Buffer.from(newContent).toString("base64");
    const out = await runGh([
      "api",
      `repos/${repository}/contents/${path}`,
      "--method", "PUT",
      "-f", `message=${commitMessage}`,
      "-f", `content=${encodedContent}`,
      "-f", `sha=${currentBlobSha}`,
      "-f", `branch=${branch}`,
      "--jq", ".commit.sha",
    ]);
    return out.trim();
  },

  /**
   * Create a new file on the repository default branch via Contents API.
   * Returns the resulting commit SHA.
   */
  async createFileOnDefaultBranch(
    repository: string,
    path: string,
    content: string,
    commitMessage: string,
  ): Promise<string> {
    const encodedContent = Buffer.from(content).toString("base64");
    const out = await runGh([
      "api",
      `repos/${repository}/contents/${path}`,
      "--method", "PUT",
      "-f", `message=${commitMessage}`,
      "-f", `content=${encodedContent}`,
      "--jq", ".commit.sha",
    ]);
    return out.trim();
  },

  /**
   * Update an existing file on the repository default branch via Contents API.
   * Returns the resulting commit SHA.
   */
  async updateFileOnDefaultBranch(
    repository: string,
    path: string,
    content: string,
    currentBlobSha: string,
    commitMessage: string,
  ): Promise<string> {
    const encodedContent = Buffer.from(content).toString("base64");
    const out = await runGh([
      "api",
      `repos/${repository}/contents/${path}`,
      "--method", "PUT",
      "-f", `message=${commitMessage}`,
      "-f", `content=${encodedContent}`,
      "-f", `sha=${currentBlobSha}`,
      "--jq", ".commit.sha",
    ]);
    return out.trim();
  },

  /**
   * Check which actors are suggested as assignees for an issue (includes the
   * Copilot coding agent if the repository has it enabled).
   * TAC-09: used to verify Copilot availability before attempting assignment.
   */
  async checkSuggestedActors(repository: string, issueNumber: number): Promise<string[]> {
    try {
      const out = await runGh([
        "api",
        `repos/${repository}/issues/${issueNumber}/assignees/suggested`,
        "--jq", "[.[].login]",
      ]);
      return JSON.parse(out) as string[];
    } catch {
      // Endpoint may not be available on all GitHub plans; return empty list
      // so the caller can fall back to a human gate instead of crashing.
      return [];
    }
  },

  /**
   * Assign the Copilot Coding Agent to an issue via the official GitHub
   * Agent Assignment API, setting the delivery branch as baseRef.
   * TAC-07/09: uses the agent assignment API; a mere body note is insufficient.
   */
  async assignCodingAgent(
    repository: string,
    issueNumber: number,
    assignee: string,
    baseRef: string,
  ): Promise<void> {
    await runGh([
      "api",
      `repos/${repository}/issues/${issueNumber}/assignees`,
      "--method", "POST",
      "-f", `assignees[]=${assignee}`,
      "-f", `base_ref=${baseRef}`,
    ]);
  },

  /**
   * List pull requests filtered by base branch.
   * TAC-10: used to find the implementation PR created by the Coding Agent.
   */
  async listPullRequestsByBase(
    repository: string,
    base: string,
  ): Promise<Array<{ number: number; headRefOid: string; headRefName: string; baseRefName: string; url: string }>> {
    const out = await runGh([
      "pr", "list", "--repo", repository,
      "--base", base,
      "--state", "open",
      "--json", "number,headRefOid,headRefName,baseRefName,url",
    ]);
    return JSON.parse(out) as Array<{ number: number; headRefOid: string; headRefName: string; baseRefName: string; url: string }>;
  },

  /**
   * Merge a pull request. Returns the merge commit SHA.
   * TAC-11: used to merge the implementation PR into the delivery branch after
   * CI is green and all reviews are resolved.
   */
  async mergePullRequest(
    repository: string,
    prNumber: number,
    method: "merge" | "squash" | "rebase" = "merge",
  ): Promise<string> {
    const out = await runGh([
      "pr", "merge", String(prNumber),
      "--repo", repository,
      `--${method}`,
      "--json", "mergeCommit",
      "--jq", ".mergeCommit.oid",
    ]);
    return out.trim();
  },

  /**
   * Read label-timeline events for an issue. Returns only "labeled" events
   * with actor login and creation timestamp, which are used by the gate
   * decision logic to filter events by the gate's openedAt timestamp (TAC-04).
   */
  async listIssueLabelEvents(repository: string, number: number): Promise<LabelEvent[]> {
    const out = await runGh([
      "api",
      `repos/${repository}/issues/${number}/timeline`,
      "--paginate",
      "--slurp",
    ]);
    return parsePaginatedLabelEvents(out);
  },

  /**
   * List every open issue that carries all of the given labels. REST
   * pagination avoids silently dropping tracking issues after a fixed limit.
   */
  async findIssuesWithLabels(
    repository: string,
    labels: string[],
  ): Promise<{ number: number; title: string; body: string }[]> {
    const args = [
      "api",
      "--method", "GET",
      `repos/${repository}/issues`,
      "-f", "state=open",
      "-f", `labels=${labels.join(",")}`,
      "-f", "per_page=100",
      "--paginate",
      "--slurp",
    ];
    const out = await runGh(args);
    return parsePaginatedIssues(out);
  },

  // ---------------------------------------------------------------------------
  // SPEC-009: Named, auditable review functions
  // ---------------------------------------------------------------------------

  /**
   * List all reviews submitted on a pull request.
   * Returns reviewer login, type, review state and submitted-at timestamp.
   * SPEC-009, decision 2.
   */
  async listPullRequestReviews(
    repository: string,
    prNumber: number,
  ): Promise<Array<{
    id: number;
    user: { login: string; type: string };
    state: string;
    submittedAt: string;
    commitId: string;
    body: string;
  }>> {
    const out = await runGh([
      "api",
      `repos/${repository}/pulls/${prNumber}/reviews`,
      "--paginate",
      "--slurp",
    ]);
    const pages = JSON.parse(out) as Array<Array<{
      id: number;
      user: { login: string; type: string };
      state: string;
      submitted_at: string;
      commit_id: string;
      body: string;
    }>>;
    return pages.flat().map((r) => ({
      id: r.id,
      user: r.user,
      state: r.state,
      submittedAt: r.submitted_at,
      commitId: r.commit_id,
      body: r.body,
    }));
  },

  /**
   * List all review threads on a pull request via the GitHub GraphQL API.
   * Returns thread id, resolution/outdated state, and the first comment's
   * author and body. SPEC-009, decision 1 & 3.
   */
  async listPullRequestReviewThreads(
    repository: string,
    prNumber: number,
  ): Promise<Array<{
    id: string;
    isResolved: boolean;
    isOutdated: boolean;
    comments: Array<{
      databaseId: number;
      reviewId: number;
      author: { login: string; __typename: string } | null;
      body: string;
      createdAt: string;
    }>;
  }>> {
    const [owner, repo] = repository.split("/");
    const query = `
      query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            reviewThreads(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                isResolved
                isOutdated
                comments(first: 1) {
                  nodes {
                    databaseId
                    pullRequestReview { databaseId }
                    author { login __typename }
                    body
                    createdAt
                  }
                }
              }
            }
          }
        }
      }
    `;
    const threads: Array<{
      id: string;
      isResolved: boolean;
      isOutdated: boolean;
      comments: Array<{ databaseId: number; reviewId: number; author: { login: string; __typename: string } | null; body: string; createdAt: string }>;
    }> = [];
    let after: string | undefined;
    for (;;) {
      const args = [
        "api", "graphql",
        "-f", `query=${query}`,
        "-f", `owner=${owner}`,
        "-f", `repo=${repo}`,
        "-F", `pr=${prNumber}`,
      ];
      if (after) args.push("-f", `after=${after}`);
      const out = await runGh(args);
      const data = JSON.parse(out) as {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: boolean; endCursor: string };
                nodes: Array<{
                  id: string;
                  isResolved: boolean;
                  isOutdated: boolean;
                  comments: { nodes: Array<{ databaseId: number; pullRequestReview: { databaseId: number } | null; author: { login: string; __typename: string } | null; body: string; createdAt: string }> };
                }>;
              };
            };
          };
        };
      };
      const page = data.data.repository.pullRequest.reviewThreads;
      for (const node of page.nodes) {
        threads.push({
          id: node.id,
          isResolved: node.isResolved,
          isOutdated: node.isOutdated,
          comments: node.comments.nodes.map((comment) => ({
            databaseId: comment.databaseId,
            reviewId: comment.pullRequestReview?.databaseId ?? 0,
            author: comment.author,
            body: comment.body,
            createdAt: comment.createdAt,
          })),
        });
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    return threads;
  },

  /**
   * Post a reply to a pull-request review thread (identified by its first
   * comment's database id). SPEC-009, TAC-06.
   */
  async replyToReviewThread(
    repository: string,
    commentId: number,
    body: string,
  ): Promise<void> {
    await runGh([
      "api",
      `repos/${repository}/pulls/comments/${commentId}/replies`,
      "--method", "POST",
      "-f", `body=${body}`,
    ]);
  },

  /**
   * Resolve a pull-request review thread via the GitHub GraphQL API.
   * Only called after the implementing commit has been verified.
   * SPEC-009, TAC-07.
   */
  async resolveReviewThread(threadId: string): Promise<void> {
    const mutation = `
      mutation($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread { id isResolved }
        }
      }
    `;
    await runGh([
      "api", "graphql",
      "-f", `query=${mutation}`,
      "-f", `threadId=${threadId}`,
    ]);
  },

  // ---------------------------------------------------------------------------
  // SPEC-012: Run-documentation writer helpers
  // ---------------------------------------------------------------------------

  /**
   * List .md files in a directory on a given ref via the Contents API.
   * Returns an empty array when the directory does not exist.
   * SPEC-012, TAC-09 (preserves existing generated snapshots in the index).
   */
  async listDirectoryMarkdownFiles(
    repository: string,
    dirPath: string,
    ref: string,
  ): Promise<Array<{ name: string; path: string }>> {
    try {
      const out = await runGh([
        "api",
        `repos/${repository}/contents/${dirPath}?ref=${encodeURIComponent(ref)}`,
      ]);
      const entries = JSON.parse(out) as Array<{ type: string; name: string; path: string }>;
      return entries
        .filter((e) => e.type === "file" && e.name.endsWith(".md"))
        .map((e) => ({ name: e.name, path: e.path }));
    } catch (err) {
      if (err instanceof GhError && /404|not found/i.test(err.message)) return [];
      throw err;
    }
  },

  /**
   * Create a single atomic commit for multiple files on a branch using the
   * Git Data API (blob → tree → commit → ref update). On a non-fast-forward
   * conflict, calls `buildFiles(newHeadSha)` to regenerate content against the
   * updated branch and retries up to `maxRetries` times (default 3).
   * Returns the new commit SHA.
   * SPEC-012, TAC-10–13 (transactional write, conflict retry, origin confirmation).
   */
  async createAtomicMultiFileCommit(
    repository: string,
    branch: string,
    buildFiles: (parentCommitSha: string) => Promise<Array<{ path: string; content: string }>>,
    commitMessage: string,
    maxRetries = 3,
  ): Promise<string> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Resolve current branch HEAD.
      const headShaRaw = await runGh([
        "api",
        `repos/${repository}/git/refs/heads/${encodeURIComponent(branch)}`,
        "--jq", ".object.sha",
      ]);
      const parentCommitSha = headShaRaw.trim();

      // Fetch the tree SHA for the parent commit.
      const commitDataRaw = await runGh([
        "api",
        `repos/${repository}/git/commits/${parentCommitSha}`,
        "--jq", ".tree.sha",
      ]);
      const baseTreeSha = commitDataRaw.trim();

      // Build (or re-build on retry) the files to commit.
      const files = await buildFiles(parentCommitSha);

      // Create blobs for each file.
      const treeEntries: Array<{ path: string; mode: string; type: string; sha: string }> = [];
      for (const file of files) {
        const blobShaRaw = await runGhWithJson(
          ["api", `repos/${repository}/git/blobs`, "--method", "POST", "--input", "-", "--jq", ".sha"],
          { content: Buffer.from(file.content).toString("base64"), encoding: "base64" },
        );
        treeEntries.push({
          path: file.path,
          mode: "100644",
          type: "blob",
          sha: blobShaRaw.trim(),
        });
      }

      // Create the new tree on top of the base tree.
      const newTreeShaRaw = await runGhWithJson(
        ["api", `repos/${repository}/git/trees`, "--method", "POST", "--input", "-", "--jq", ".sha"],
        { base_tree: baseTreeSha, tree: treeEntries },
      );
      const newTreeSha = newTreeShaRaw.trim();

      // Create the commit.
      const newCommitShaRaw = await runGhWithJson(
        ["api", `repos/${repository}/git/commits`, "--method", "POST", "--input", "-", "--jq", ".sha"],
        { message: commitMessage, tree: newTreeSha, parents: [parentCommitSha] },
      );
      const newCommitSha = newCommitShaRaw.trim();

      // Update the ref (fast-forward only). Retry on conflict.
      try {
        await runGhWithJson(
          ["api", `repos/${repository}/git/refs/heads/${encodeURIComponent(branch)}`, "--method", "PATCH", "--input", "-"],
          { sha: newCommitSha, force: false },
        );
        return newCommitSha;
      } catch (err) {
        const isConflict =
          err instanceof GhError && /not a fast forward|422/i.test(err.message);
        if (!isConflict || attempt >= maxRetries) throw err;
        // On conflict, loop again with the updated branch HEAD.
      }
    }
    // Unreachable but satisfies TypeScript.
    throw new Error("createAtomicMultiFileCommit: exceeded maximum retries");
  },

  /**
   * Verify that a commit SHA is the current HEAD of the given branch (or is
   * reachable from it). Used to confirm origin presence after a push.
   * SPEC-012, TAC-13.
   */
  async verifyCommitOnBranch(
    repository: string,
    branch: string,
    expectedCommitSha: string,
  ): Promise<boolean> {
    try {
      const out = await runGh([
        "api",
        `repos/${repository}/git/refs/heads/${encodeURIComponent(branch)}`,
        "--jq", ".object.sha",
      ]);
      const currentHead = out.trim();
      // Accept exact match; for an ancestor check a separate comparison
      // commit endpoint would be needed but the atomic writer keeps the SHA.
      return currentHead === expectedCommitSha;
    } catch {
      return false;
    }
  },

  /**
   * Post a structured audit comment to the tracking issue. This creates the
   * immutable REQ-005-correlated audit record on GitHub before `auditConfirmedAt`
   * is recorded in run state. Returns the ISO timestamp of confirmation.
   * SPEC-012, TAC-05 / §8.
   */
  async postDocumentationAuditComment(
    repository: string,
    issueNumber: number,
    auditData: {
      runId: string;
      processKennung: "DOCUMENTATION_UPDATE";
      actor: "GITHUB_ACTIONS";
      role: "GITHUB_ACTIONS_TOKEN";
      correlationRunId: string;
      correlationIssue: string;
      deliveryPr: number | undefined;
      sourceCommitSha: string;
      documentationCommitSha: string;
      idempotencyKey: string;
      generatedAt: string;
    },
  ): Promise<string> {
    const body = [
      "<!-- harness:audit-record type=DOCUMENTATION_UPDATE -->",
      `**Audit Record — DOCUMENTATION_UPDATE**`,
      `- process: \`${auditData.processKennung}\``,
      `- actor: \`${auditData.actor}\``,
      `- role: \`${auditData.role}\``,
      `- runId: \`${auditData.runId}\``,
      `- correlation: \`${auditData.correlationRunId}\` / \`${auditData.correlationIssue}\``,
      ...(auditData.deliveryPr !== undefined ? [`- deliveryPr: #${auditData.deliveryPr}`] : []),
      `- sourceCommit: \`${auditData.sourceCommitSha}\``,
      `- documentationCommit: \`${auditData.documentationCommitSha}\``,
      `- idempotencyKey: \`${auditData.idempotencyKey}\``,
      `- generatedAt: \`${auditData.generatedAt}\``,
    ].join("\n");
    await runGh(["issue", "comment", String(issueNumber), "--repo", repository, "--body", body]);
    return new Date().toISOString();
  },
};
