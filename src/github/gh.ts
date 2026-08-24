import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import { validateStagedPaths } from "../documentation/path-validator.js";
import {
  DEFAULT_REUSABLE_WORKFLOW_REPOSITORY,
  PROCESS_AUDIT_RECEIVER_MARKER,
  PROCESS_AUDIT_RECEIVER_PATH,
} from "../workflows/template-catalog.js";
import { parseJournalEntry } from "../audit/journalParser.js";

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

export function buildAgentAssignmentArgs(
  repository: string,
  issueNumber: number,
  assignee: string,
  baseRef: string,
): string[] {
  return [
    "api",
    `repos/${repository}/issues/${issueNumber}/assignees`,
    "--method", "POST",
    "-f", `assignees[]=${assignee}`,
    "-f", `agent_assignment[target_repo]=${repository}`,
    "-f", `agent_assignment[base_branch]=${baseRef}`,
  ];
}

export function buildMergePullRequestArgs(
  repository: string,
  prNumber: number,
  method: "merge" | "squash" | "rebase",
  expectedHeadSha: string,
): string[] {
  return [
    "api",
    `repos/${repository}/pulls/${prNumber}/merge`,
    "--method", "PUT",
    "-f", `merge_method=${method}`,
    "-f", `sha=${expectedHeadSha}`,
  ];
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
 * Supported marker versions for the process-audit receiver workflow.
 * The receiver YAML must contain the managed marker with one of these versions.
 */
const SUPPORTED_RECEIVER_MARKER_VERSIONS = ["v1"] as const;

/**
 * Access roles whose credentials can dispatch events to repositories other
 * than the one the workflow was triggered from (cross-repository-capable).
 *
 * The default built-in `GITHUB_TOKEN` is repository-scoped and is NOT in
 * this set.  Cross-repo audit dispatch requires an explicit PAT, GitHub App
 * token, or equivalent.
 */
export const CROSS_REPO_ALLOWED_ROLES = new Set([
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "GITHUB_APP_USER_AUTHORIZATION",
]);

/**
 * Validate the content of an installed process-audit receiver workflow YAML.
 *
 * Extracted as a separate exported function so that it can be tested
 * independently of the live `preflightRunDocumentationWriter` (which requires
 * GitHub API access).  The production preflight calls this function with the
 * content fetched from the recorder's default branch.
 *
 * Checks (in order):
 * 1. Managed marker is present with a supported version.
 * 2. `repository_dispatch` event with type `process_audit` is configured.
 * 3. `uses:` delegates to the canonical remote reusable workflow.
 * 4. The `uses:` ref is immutable (version tag or 40-char SHA).
 * 5. The `uses:` ref matches the expected configured harness ref.
 * 6. The `harness-ref:` input is wired and its value matches the `uses:` ref.
 *
 * @param content      Raw YAML content of the receiver workflow file.
 * @param expectedRef  The harness ref the caller expects the receiver to use
 *                     (e.g. `"v0.2.2"` from `DEFAULT_PROCESS_AUDIT_RECEIVER_WORKFLOW_REF`).
 * @param receiverPath Path used in error messages (e.g. `PROCESS_AUDIT_RECEIVER_PATH`).
 * @param recorder     Repository name used in error messages.
 * @throws {Error}  When any check fails, with a descriptive human-readable message.
 */
export function validateReceiverContent(
  content: string,
  expectedRef: string,
  receiverPath: string,
  recorder: string,
): void {
  // Check 1: Managed marker with supported version.
  // Extract the marker base (without the version suffix) and the version separately
  // so that the version check reads from the content, not from the constant.
  const markerBase = PROCESS_AUDIT_RECEIVER_MARKER.replace(/\s+\S+$/, ""); // strip trailing token
  const markerInContentMatch = content.match(
    new RegExp(`${markerBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(\\S+)`),
  );
  if (!markerInContentMatch) {
    throw new Error(
      `run-documentation-writer preflight failed: the process-audit receiver at ` +
      `'${receiverPath}' in '${recorder}' is not a pi-spec-harness managed receiver ` +
      `(expected marker '${PROCESS_AUDIT_RECEIVER_MARKER}' not found). ` +
      `Run \`harness install process-audit-receiver\` in '${recorder}' to install a compatible receiver.`,
    );
  }
  // The version is whatever the content declares after the marker base — it
  // may differ from the constant when a newer receiver format is installed.
  const markerVersion = markerInContentMatch[1];
  if (!(SUPPORTED_RECEIVER_MARKER_VERSIONS as ReadonlyArray<string>).includes(markerVersion)) {
    throw new Error(
      `run-documentation-writer preflight failed: the process-audit receiver at ` +
      `'${receiverPath}' in '${recorder}' uses unsupported marker version '${markerVersion}'. ` +
      `Supported versions: ${SUPPORTED_RECEIVER_MARKER_VERSIONS.join(", ")}. ` +
      `Re-install with \`harness install process-audit-receiver\`.`,
    );
  }

  // Check 2: event trigger.
  if (!content.includes("repository_dispatch") || !content.includes("process_audit")) {
    throw new Error(
      `run-documentation-writer preflight failed: the process-audit receiver at ` +
      `'${receiverPath}' in '${recorder}' does not appear to handle ` +
      `'repository_dispatch' events of type 'process_audit'. ` +
      `Re-install with \`harness install process-audit-receiver\`.`,
    );
  }

  // Check 3: uses: calls canonical remote reusable workflow.
  const expectedUsesPrefix = `${DEFAULT_REUSABLE_WORKFLOW_REPOSITORY}/.github/workflows/process-audit-automation.yml@`;
  const usesLineMatch = content.match(/uses:\s*(\S+)/);
  if (!usesLineMatch) {
    throw new Error(
      `run-documentation-writer preflight failed: the process-audit receiver at ` +
      `'${receiverPath}' in '${recorder}' has no 'uses:' directive. ` +
      `Re-install with \`harness install process-audit-receiver\`.`,
    );
  }
  const usesValue = usesLineMatch[1];
  if (!usesValue.startsWith(expectedUsesPrefix)) {
    throw new Error(
      `run-documentation-writer preflight failed: the process-audit receiver at ` +
      `'${receiverPath}' in '${recorder}' delegates to '${usesValue}' ` +
      `instead of the canonical '${expectedUsesPrefix}<ref>'. ` +
      `Re-install with \`harness install process-audit-receiver\`.`,
    );
  }

  // Check 4: ref must be immutable.
  const harnessRef = usesValue.slice(expectedUsesPrefix.length);
  const isMutableRef =
    !/^v\d/.test(harnessRef) &&           // not a version tag
    !/^[0-9a-f]{40}$/.test(harnessRef);   // not a full SHA
  if (isMutableRef) {
    throw new Error(
      `run-documentation-writer preflight failed: the process-audit receiver at ` +
      `'${receiverPath}' in '${recorder}' pins to mutable ref '${harnessRef}'. ` +
      `Use an immutable version tag (e.g. 'v0.2.2') or a full commit SHA. ` +
      `Re-install with \`harness install process-audit-receiver --harness-ref <immutable-ref>\`.`,
    );
  }

  // Check 5: uses: ref must match the expected configured harness ref.
  if (harnessRef !== expectedRef) {
    throw new Error(
      `run-documentation-writer preflight failed: the process-audit receiver at ` +
      `'${receiverPath}' in '${recorder}' uses ref '${harnessRef}' but the ` +
      `configured expected ref is '${expectedRef}'. ` +
      `Re-install with \`harness install process-audit-receiver --harness-ref ${expectedRef}\`.`,
    );
  }

  // Check 6: harness-ref: input must be present and match the uses: ref.
  if (!content.includes("harness-ref:")) {
    throw new Error(
      `run-documentation-writer preflight failed: the process-audit receiver at ` +
      `'${receiverPath}' in '${recorder}' is missing the required ` +
      `'harness-ref:' input. Re-install with \`harness install process-audit-receiver\`.`,
    );
  }
  // Extract the harness-ref: value and verify it matches the uses: ref.
  const harnessRefInputMatch = content.match(/harness-ref:\s*['"]?([^\s'"]+)['"]?/);
  if (harnessRefInputMatch) {
    const harnessRefInput = harnessRefInputMatch[1];
    if (harnessRefInput !== harnessRef) {
      throw new Error(
        `run-documentation-writer preflight failed: the process-audit receiver at ` +
        `'${receiverPath}' in '${recorder}' has mismatched refs: ` +
        `uses: '${harnessRef}' but harness-ref input is '${harnessRefInput}'. ` +
        `Re-install with \`harness install process-audit-receiver --harness-ref ${expectedRef}\`.`,
      );
    }
  }
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
      "number,title,body,state,url,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,baseRefName,headRefName,mergedAt,mergeCommit,mergedBy"]);
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
    await runGh(buildAgentAssignmentArgs(repository, issueNumber, assignee, baseRef));
  },

  async updatePullRequestBody(repository: string, number: number, body: string): Promise<void> {
    await runGh(["pr", "edit", String(number), "--repo", repository, "--body", body]);
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
   * Find the first open or merged PR whose HEAD branch matches the given ref.
   * Returns undefined when no matching PR exists.
   * SPEC-014 TAC-02: used to adopt the spec PR created by the agent.
   */
  async findPullRequestByHead(
    repository: string,
    headBranch: string,
  ): Promise<{ number: number; headRefOid: string; headRefName: string; state: string; mergedAt: string | null; mergeCommit: { oid: string } | null; url: string } | undefined> {
    const out = await runGh([
      "pr", "list", "--repo", repository,
      "--head", headBranch,
      "--state", "all",
      "--json", "number,headRefOid,headRefName,state,mergedAt,mergeCommit,url",
      "--limit", "1",
    ]);
    const results = JSON.parse(out) as Array<{
      number: number;
      headRefOid: string;
      headRefName: string;
      state: string;
      mergedAt: string | null;
      mergeCommit: { oid: string } | null;
      url: string;
    }>;
    return results[0];
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
    expectedHeadSha: string,
  ): Promise<string> {
    await runGh(buildMergePullRequestArgs(repository, prNumber, method, expectedHeadSha));
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const out = await runGh([
        "pr", "view", String(prNumber),
        "--repo", repository,
        "--json", "state,mergeCommit",
      ]);
      const result = JSON.parse(out) as { state: string; mergeCommit: { oid: string } | null };
      if (result.state === "MERGED" && result.mergeCommit?.oid) {
        return result.mergeCommit.oid;
      }
      await wait(2_000);
    }
    throw new GhError(`asynchronous merge of PR #${prNumber} was not confirmed within 30 seconds`);
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
   * updated branch and retries up to `maxRetries` times total (default 3).
   * When `expectedPaths` is provided, `validateStagedPaths()` is called on the
   * resolved file list before any blob is created, so staging an unexpected
   * path is caught before the first external write. Returns the new commit SHA.
   * SPEC-012, TAC-10–13 (transactional write, conflict retry, origin confirmation).
   */
  async createAtomicMultiFileCommit(
    repository: string,
    branch: string,
    buildFiles: (parentCommitSha: string) => Promise<Array<{ path: string; content: string }>>,
    commitMessage: string,
    maxRetries = 3,
    expectedPaths?: [string, string, string],
  ): Promise<string> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
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

      // Validate that exactly the expected paths are staged before any write.
      if (expectedPaths) {
        validateStagedPaths(files.map((f) => f.path), expectedPaths);
      }

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
        if (!isConflict || attempt === maxRetries - 1) throw err;
        // On conflict, loop again with the updated branch HEAD.
      }
    }
    // Unreachable but satisfies TypeScript.
    throw new Error("createAtomicMultiFileCommit: exceeded maximum retries");
  },

  /**
   * Returns the SHA of the most recent commit on `branch` that touched the
   * given `filePath`, or `undefined` if the file has never been committed on
   * that branch. Used by the crash-after-push reconciler to adopt an already-
   * landed documentation commit without creating a duplicate. SPEC-012, TAC-11.
   */
  async getLatestCommitForPath(
    repository: string,
    branch: string,
    filePath: string,
  ): Promise<string | undefined> {
    try {
      const out = await runGh([
        "api",
        `repos/${repository}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(filePath)}&per_page=1`,
        "--jq", ".[0].sha // empty",
      ]);
      const sha = out.trim();
      return sha.length > 0 ? sha : undefined;
    } catch {
      return undefined;
    }
  },

  /**
   * Returns the set of file paths changed by a specific commit.
   * Used to verify that an adopted crash-after-push commit atomically contains
   * all three expected documentation paths. SPEC-012, TAC-11.
   *
   * Uses the GitHub Commits API (`GET /repos/{owner}/{repo}/commits/{sha}`).
   * Returns an empty set on any error so the caller can treat it as "unknown"
   * and fall through to a fresh commit.
   */
  async getCommitChangedPaths(repository: string, commitSha: string): Promise<Set<string>> {
    try {
      const out = await runGh([
        "api",
        `repos/${repository}/commits/${encodeURIComponent(commitSha)}`,
        "--jq", "[.files[].filename] | join(\"\\n\")",
      ]);
      const paths = out.trim().split("\n").filter((p) => p.length > 0);
      return new Set(paths);
    } catch {
      return new Set();
    }
  },

  /**
   * Verify that a commit SHA is the current HEAD of the given branch or is
   * reachable (an ancestor) from it. Uses the GitHub compare API to check
   * ancestry so that a subsequent legitimate commit on the branch does not
   * produce a false negative. Returns true when status is "identical" (same
   * commit) or "behind" (HEAD has moved ahead, so expectedCommitSha is an
   * ancestor). SPEC-012, TAC-13.
   *
   * Note on `behind`: in GitHub's compare semantics, comparing
   * `expectedCommitSha...HEAD` where HEAD has advanced means the result
   * is `ahead` (HEAD is ahead of base). We therefore compare
   * `HEAD...expectedCommitSha`; if HEAD is behind the expected SHA that
   * means the expected SHA is NOT reachable, so we reject it. We accept
   * "identical" (same commit) and "behind" (HEAD has moved ahead of the
   * expected SHA, meaning the expected SHA is reachable from HEAD).
   *
   * Practically: after an atomic push that returned `expectedCommitSha`, the
   * branch ref IS the expected SHA. Any later legitimate commit on the branch
   * makes HEAD an ancestor of nothing but a descendant of `expectedCommitSha`,
   * so comparing `expectedCommitSha...HEAD` yields "ahead" — which we also
   * accept.
   */
  async verifyCommitOnBranch(
    repository: string,
    branch: string,
    expectedCommitSha: string,
  ): Promise<boolean> {
    try {
      // Compare base=expectedCommitSha with head=branch.
      // "ahead" → HEAD is ahead of the expected commit → expected is an ancestor ✓
      // "identical" → same commit ✓
      // "behind" | "diverged" → expected commit is NOT in HEAD's history ✗
      const out = await runGh([
        "api",
        `repos/${repository}/compare/${expectedCommitSha}...${encodeURIComponent(branch)}`,
        "--jq", ".status",
      ]);
      const status = out.trim();
      return status === "ahead" || status === "identical";
    } catch {
      return false;
    }
  },

  /**
   * Dispatch a SPEC-005 envelope-v1 `process_audit` event to the configured
   * recorder repository. The event is delivered via `repository_dispatch` with
   * `event_type: "process_audit"` and the full payload nested under
   * `client_payload.audit` (envelope-v1 contract: exactly one top-level field,
   * exactly 15 canonical fields as defined in SPEC-005).
   *
   * This is the producer side of the REQ-005 audit contract. Delivery is
   * confirmed only after `confirmAuditEventInJournal()` finds the idempotency
   * key on the recorder's default branch; an HTTP 204 response is only accepted
   * as enqueued, not as persisted (SPEC-005 §4 / SPEC-012 §8).
   */
  async dispatchProcessAuditEnvelopeV1(
    recorderRepository: string,
    payload: {
      schema_version: 1;
      occurred_at: string;
      process_instance: string;
      idempotency_key: string;
      process_code: "DOCUMENTATION_UPDATE";
      actor: string;
      access_role: string;
      supporting_access_roles: string[];
      outcome: string;
      repository: string;
      artifact: string;
      correlation_ids: string[];
      evidence: string[];
      reason: string;
      description: string;
    },
  ): Promise<void> {
    await runGhWithJson(
      ["api", `repos/${recorderRepository}/dispatches`, "--method", "POST", "--input", "-"],
      { event_type: "process_audit", client_payload: { audit: payload } },
    );
  },

  /**
   * Poll the recorder repository's journal directory for a file that contains
   * the given idempotency key on its default branch.  Returns the
   * `confirmed_at` value extracted from the journal entry.
   *
   * This implements the producer-side confirmation step from SPEC-005 §4:
   * an event is considered durably delivered only when its `idempotency_key`
   * appears in a persisted file on the recorder's default branch — not merely
   * when the `repository_dispatch` HTTP 204 is received.
   *
   * Fail-closed: if the polling loop exhausts all attempts, an Error is
   * thrown (never silently falls through). Callers must treat an unconfirmed
   * delivery as a failure and increment the delivery-failure counter.
   *
   * @param recorderRepository  owner/repo of the audit recorder
   * @param journalDirectory    path to the journal directory (e.g. "docs/process-audit/journal")
   * @param idempotencyKey      key to search for in journal files
   * @param branch              default branch to read from (e.g. "main")
   * @param maxAttempts         maximum number of polling attempts (default 6)
   * @param retryDelayMs        milliseconds to wait between attempts (default 10000)
   */
  async confirmAuditEventInJournal(
    recorderRepository: string,
    journalDirectory: string,
    idempotencyKey: string,
    branch: string,
    maxAttempts = 6,
    retryDelayMs = 10_000,
  ): Promise<string> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
      }
      // List all .md files in the journal directory.  An empty or missing
      // directory is not an error here — the workflow may not have run yet.
      const files = await this.listDirectoryMarkdownFiles(recorderRepository, journalDirectory, branch);
      for (const file of files) {
        // Fail closed: any file-read error propagates immediately; unreadable
        // journal files are NOT silently skipped (SPEC-005 §external-contract).
        const { content } = await this.getFileContent(recorderRepository, file.path, branch);
        // parseJournalEntry is the single shared implementation from
        // src/audit/journalParser.js — no inline duplication.
        const result = parseJournalEntry(content, file.path, idempotencyKey);
        if (result === null) {
          continue; // idempotency key not in this file
        }
        return result.confirmedAt;
      }
    }
    throw new Error(
      `audit event with idempotency_key "${idempotencyKey}" not found in journal ` +
      `"${journalDirectory}" of "${recorderRepository}" after ${maxAttempts} attempt(s). ` +
      `Ensure the process-audit-receiver workflow is installed in the recorder repository.`,
    );
  },

  /**
   * Preflight capability check for the run-documentation writer (SPEC-012 §11 / TAC-17).
   *
   * Verifies before any productive write that:
   * 1. The default branch exists and is readable.
   * 2. The authenticated token has `push` (= `contents: write`) permission on
   *    the documentation repository.
   * 3. The configured audit recorder repository is reachable (SPEC-012 §8 /
   *    TAC-17 "fehlenden Auditvertrag"). Missing or unreachable recorder blocks
   *    execution; this check is NOT deferred.
   *
   * @throws {Error} with a human-readable message describing the missing capability.
   */
  async preflightRunDocumentationWriter(
    repository: string,
    branch: string,
    recorderRepository?: string,
    expectedHarnessRef?: string,
    credentialAccessRole?: string,
  ): Promise<void> {
    // Resolve defaults.
    const recorder = recorderRepository ?? repository;
    const { DEFAULT_PROCESS_AUDIT_RECEIVER_WORKFLOW_REF } = await import("../workflows/template-catalog.js");
    const expectedRef = expectedHarnessRef ?? DEFAULT_PROCESS_AUDIT_RECEIVER_WORKFLOW_REF;

    // Cross-repo check: the default repository-scoped GITHUB_TOKEN cannot
    // dispatch events to a different repository.  Permit cross-repo dispatch
    // only when an explicit cross-repo-capable access role is provided
    // (e.g. a PAT or a GitHub App installation token).
    if (recorder !== repository) {
      const role = credentialAccessRole ?? "GITHUB_TOKEN";
      if (!CROSS_REPO_ALLOWED_ROLES.has(role)) {
        throw new Error(
          `run-documentation-writer preflight failed: audit recorder repository '${recorder}' ` +
          `is in a different repository from '${repository}'. ` +
          `The configured credential role '${role}' is repository-scoped and cannot dispatch events ` +
          `to a different repository. ` +
          `Set --audit-access-role to GITHUB_PERSONAL_ACCESS_TOKEN or GITHUB_APP_USER_AUTHORIZATION ` +
          `and provide the corresponding token, or configure the recorder to be the same repository ` +
          `as the documentation target.`,
        );
      }
    }

    // Check 1: branch exists and is readable.
    try {
      await runGh([
        "api",
        `repos/${repository}/git/refs/heads/${encodeURIComponent(branch)}`,
        "--jq", ".object.sha",
      ]);
    } catch (err) {
      const msg = err instanceof GhError ? err.message : String(err);
      if (/404|not found/i.test(msg)) {
        throw new Error(
          `run-documentation-writer preflight failed: branch '${branch}' not found in '${repository}'. ` +
          `Ensure the repository and branch name are correct.`,
        );
      }
      throw new Error(
        `run-documentation-writer preflight failed: cannot read branch '${branch}' in '${repository}': ${msg}. ` +
        `Ensure the workflow has 'contents: read' at minimum.`,
      );
    }

    // Check 2: token has push (contents: write) permission.
    try {
      const permsRaw = await runGh([
        "api",
        `repos/${repository}`,
        "--jq", ".permissions.push",
      ]);
      const hasPush = permsRaw.trim() === "true";
      if (!hasPush) {
        throw new Error(
          `run-documentation-writer preflight failed: the authenticated token does not have 'push' ` +
          `(contents: write) permission on '${repository}'. ` +
          `Enable 'contents: write' in the workflow's 'permissions' block.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("run-documentation-writer preflight")) throw err;
      const msg = err instanceof GhError ? err.message : String(err);
      throw new Error(
        `run-documentation-writer preflight failed: cannot determine permissions for '${repository}': ${msg}. ` +
        `Enable 'contents: write' in the workflow's 'permissions' block.`,
      );
    }

    // Check 3: audit recorder is reachable (SPEC-012 §8 / TAC-17).
    //
    // The recorder defaults to the tracking-issue repository (same token, same
    // permissions). This check is not deferred: a missing or unreachable
    // recorder blocks the writer before any state is mutated.
    try {
      await runGh([
        "api",
        `repos/${recorder}`,
        "--jq", ".full_name",
      ]);
    } catch (err) {
      const msg = err instanceof GhError ? err.message : String(err);
      throw new Error(
        `run-documentation-writer preflight failed: audit recorder repository '${recorder}' is not reachable: ${msg}. ` +
        `Ensure the process-audit-receiver workflow is installed and the token has access to '${recorder}'.`,
      );
    }

    // Check 4: the process-audit receiver workflow is installed, compatible,
    // and pinned to the expected configured harness ref (SPEC-012 §11 / TAC-17).
    //
    // Uses validateReceiverContent() which verifies: managed marker + version,
    // event/trigger wiring, canonical uses: target, immutable ref, ref matches
    // expectedRef, and harness-ref: input matches uses: ref.
    let receiverFile: { content: string } | undefined;
    try {
      receiverFile = await this.getFileContentIfExists(recorder, PROCESS_AUDIT_RECEIVER_PATH);
    } catch (err) {
      const msg = err instanceof GhError ? err.message : String(err);
      throw new Error(
        `run-documentation-writer preflight failed: cannot verify process-audit receiver in '${recorder}': ${msg}.`,
      );
    }
    if (!receiverFile) {
      throw new Error(
        `run-documentation-writer preflight failed: process-audit receiver workflow ` +
        `'${PROCESS_AUDIT_RECEIVER_PATH}' not found in '${recorder}'. ` +
        `Run \`harness install process-audit-receiver\` in '${recorder}' to install it.`,
      );
    }
    validateReceiverContent(receiverFile.content, expectedRef, PROCESS_AUDIT_RECEIVER_PATH, recorder);
  },
};
