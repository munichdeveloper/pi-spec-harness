#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const release = await import("../dist/release.js");
const catalog = await import("../dist/workflows/template-catalog.js");
const expectedTag = `v${packageJson.version}`;
const requestedTag = process.env.HARNESS_RELEASE_TAG;

function run(command, args) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

if (!requestedTag) {
  throw new Error("release identity failed: HARNESS_RELEASE_TAG is required");
}
if (requestedTag !== expectedTag || release.HARNESS_VERSION !== packageJson.version) {
  throw new Error(
    `release identity failed: tag ${requestedTag}, package ${packageJson.version}, and catalog ${release.HARNESS_VERSION} must agree`,
  );
}

const headCommit = run("git", ["rev-parse", "HEAD"]);
const tagCommit = run("git", ["rev-parse", `${requestedTag}^{commit}`]);
if (tagCommit !== headCommit) {
  throw new Error(`release identity failed: ${requestedTag} resolves to ${tagCommit}, expected HEAD ${headCommit}`);
}
run("git", ["merge-base", "--is-ancestor", release.DEFAULT_HARNESS_WORKFLOW_REF, tagCommit]);

for (const entry of catalog.WORKFLOW_TEMPLATE_CATALOG) {
  const pinned = run("git", ["show", `${release.DEFAULT_HARNESS_WORKFLOW_REF}:${entry.reusableWorkflowRepoPath}`]);
  const tagged = run("git", ["show", `${requestedTag}:${entry.reusableWorkflowRepoPath}`]);
  if (pinned !== tagged) {
    throw new Error(
      `release identity failed: ${entry.reusableWorkflowRepoPath} differs between default pin and ${requestedTag}`,
    );
  }
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  version: packageJson.version,
  tag: requestedTag,
  releaseCommit: tagCommit,
  immutableWorkflowRef: release.DEFAULT_HARNESS_WORKFLOW_REF,
  workflowContentParity: "passed",
  outcome: "passed",
}, null, 2)}\n`);
