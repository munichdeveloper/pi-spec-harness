import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

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
      "number,title,body,state,labels,url,comments"]);
    return JSON.parse(out) as {
      number: number;
      title: string;
      body: string;
      state: string;
      labels: { name: string }[];
      url: string;
      comments: { author: { login: string }; body: string; createdAt: string }[];
    };
  },

  async viewPullRequest(repository: string, number: number) {
    const out = await runGh(["pr", "view", String(number), "--repo", repository, "--json",
      "number,title,body,state,url,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid"]);
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
};
