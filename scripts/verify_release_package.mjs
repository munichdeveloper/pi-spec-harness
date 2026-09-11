#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

function run(command, args, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const cliOutput = run(process.execPath, [resolve(root, "dist/cli.js"), "--help"]);
if (!cliOutput.includes("init") || !cliOutput.includes("status")) {
  throw new Error("release smoke failed: built CLI help is missing core commands");
}

const catalog = await import("../dist/workflows/template-catalog.js");
const release = await import("../dist/release.js");
if (release.HARNESS_VERSION !== packageJson.version) {
  throw new Error(
    `release smoke failed: catalog version ${release.HARNESS_VERSION} does not match package ${packageJson.version}`,
  );
}
if (catalog.WORKFLOW_TEMPLATE_CATALOG.length !== 9) {
  throw new Error(
    `release smoke failed: expected 9 workflow templates, got ${catalog.WORKFLOW_TEMPLATE_CATALOG.length}`,
  );
}
if (!/^[a-f0-9]{40}$/.test(release.DEFAULT_HARNESS_WORKFLOW_REF)) {
  throw new Error("release smoke failed: default workflow ref is not an immutable full SHA");
}
run("git", ["cat-file", "-e", `${release.DEFAULT_HARNESS_WORKFLOW_REF}^{commit}`]);
run("git", ["merge-base", "--is-ancestor", release.DEFAULT_HARNESS_WORKFLOW_REF, "HEAD"]);
for (const entry of catalog.WORKFLOW_TEMPLATE_CATALOG) {
  run("git", ["cat-file", "-e", `${release.DEFAULT_HARNESS_WORKFLOW_REF}:${entry.reusableWorkflowRepoPath}`]);
  const pinnedWorkflow = run("git", ["show", `${release.DEFAULT_HARNESS_WORKFLOW_REF}:${entry.reusableWorkflowRepoPath}`]);
  const candidateWorkflow = run("git", ["show", `HEAD:${entry.reusableWorkflowRepoPath}`]);
  if (pinnedWorkflow !== candidateWorkflow) {
    const expectedDigest = release.PENDING_REUSABLE_WORKFLOW_SHA256?.[entry.reusableWorkflowRepoPath];
    const actualDigest = createHash("sha256").update(candidateWorkflow).digest("hex");
    if (expectedDigest === actualDigest) {
      continue;
    }
    throw new Error(
      `release smoke failed: ${entry.reusableWorkflowRepoPath} differs between default pin ${release.DEFAULT_HARNESS_WORKFLOW_REF} and release candidate without an exact pending SHA-256 declaration`,
    );
  }
}

for (const path of Object.keys(release.PENDING_REUSABLE_WORKFLOW_SHA256 ?? {})) {
  const entry = catalog.WORKFLOW_TEMPLATE_CATALOG.find((candidate) => candidate.reusableWorkflowRepoPath === path);
  if (!entry) {
    throw new Error(`release smoke failed: pending reusable workflow path is not managed: ${path}`);
  }
  const digest = release.PENDING_REUSABLE_WORKFLOW_SHA256[path];
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`release smoke failed: pending reusable workflow digest is not SHA-256: ${path}`);
  }
  const pinnedWorkflow = run("git", ["show", `${release.DEFAULT_HARNESS_WORKFLOW_REF}:${path}`]);
  const candidateWorkflow = run("git", ["show", `HEAD:${path}`]);
  if (pinnedWorkflow === candidateWorkflow) {
    throw new Error(`release smoke failed: stale pending reusable workflow declaration: ${path}`);
  }
}

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("release smoke failed: npm_execpath is unavailable; run via npm run release:smoke");
}
const packResult = JSON.parse(
  run(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json"]),
);
const packed = packResult[0];
const tarballPath = resolve(root, packed.filename);
const paths = new Set(packed.files.map((file) => file.path));
const requiredPaths = [
  "dist/cli.js",
  "dist/audit/journalParser.js",
  "dist/workflows/template-catalog.js",
  "skills/pi-spec-harness/SKILL.md",
];
for (const path of requiredPaths) {
  if (!paths.has(path)) {
    throw new Error(`release smoke failed: package is missing ${path}`);
  }
}

const forbiddenPrefixes = ["test/", "docs/process-audit/journal/", ".github/"];
for (const file of packed.files) {
  if (forbiddenPrefixes.some((prefix) => file.path.startsWith(prefix))) {
    throw new Error(`release smoke failed: package contains non-runtime path ${file.path}`);
  }
}

const consumer = mkdtempSync(resolve(tmpdir(), "pi-spec-harness-release-smoke-"));
const projectConfigPath = resolve(consumer, "project-config.json");
const auditPath = resolve(consumer, "docs/process-audit/journal/existing.md");
const projectConfig = '{"project":"synthetic-consumer","custom":true}\n';
const auditEntry = "---\nidempotency_key: synthetic-existing-audit\n---\n";

try {
  mkdirSync(resolve(consumer, "docs/process-audit/journal"), { recursive: true });
  writeFileSync(
    resolve(consumer, "package.json"),
    JSON.stringify({ name: "synthetic-harness-consumer", private: true }, null, 2) + "\n",
  );
  writeFileSync(projectConfigPath, projectConfig);
  writeFileSync(auditPath, auditEntry);

  const installArgs = [npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath];
  run(process.execPath, installArgs, consumer);
  const installedCli = resolve(consumer, "node_modules/pi-spec-harness/dist/cli.js");
  const installedHelp = run(process.execPath, [installedCli, "--help"], consumer);
  if (!installedHelp.includes("init") || !installedHelp.includes("status")) {
    throw new Error("release smoke failed: clean-installed CLI does not expose core commands");
  }
  const installedCatalog = await import(pathToFileURL(
    resolve(consumer, "node_modules/pi-spec-harness/dist/workflows/template-catalog.js"),
  ).href);
  for (const entry of installedCatalog.WORKFLOW_TEMPLATE_CATALOG) {
    const rendered = entry.renderReference();
    if (!rendered.includes(`@${release.DEFAULT_HARNESS_WORKFLOW_REF}`)) {
      throw new Error(`release smoke failed: clean-installed default for ${entry.name} does not use the release pin`);
    }
  }

  // Reinstalling the release candidate models an idempotent package upgrade.
  // Consumer-owned configuration and the append-only audit journal must not be
  // mutated by package installation or reconciliation.
  run(process.execPath, installArgs, consumer);
  if (readFileSync(projectConfigPath, "utf8") !== projectConfig) {
    throw new Error("release smoke failed: upgrade changed consumer project configuration");
  }
  if (readFileSync(auditPath, "utf8") !== auditEntry) {
    throw new Error("release smoke failed: upgrade changed existing audit history");
  }
} finally {
  rmSync(consumer, { recursive: true, force: true });
  rmSync(tarballPath, { force: true });
}

process.stdout.write(
  JSON.stringify(
    {
      schemaVersion: 1,
      version: packageJson.version,
      cli: "passed",
      workflowTemplates: catalog.WORKFLOW_TEMPLATE_CATALOG.length,
      immutableWorkflowRef: release.DEFAULT_HARNESS_WORKFLOW_REF,
      workflowContentParity: "passed",
      packageEntries: packed.entryCount,
      cleanInstall: "passed",
      cleanInstallDefaultPin: "passed",
      upgradePreservation: "passed",
      requiredRuntimeFiles: requiredPaths,
      outcome: "passed",
    },
    null,
    2,
  ) + "\n",
);
