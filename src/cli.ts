#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import yargs, { type Argv } from "yargs";
import { hideBin } from "yargs/helpers";
import {
  acknowledgeRejectedHumanGate,
  checkHumanGateIssue,
  computeGateDecision,
  prepareHumanGateIssue,
  publishHumanGateIssue,
  postGateDecision,
} from "./gates/human-gate.js";
import { github } from "./github/gh.js";
import { orchestrate } from "./orchestrator.js";
import { getSpecAssignee } from "./spec/spec-parser.js";
import {
  BUG_WORKFLOW_REFERENCE_PATH,
  DEFAULT_BUG_TRIAGE_WORKFLOW_REF,
  decideBugWorkflowInstall,
  renderBugWorkflowReference,
} from "./bug/workflow-reference.js";
import { findWorkflowTemplate, resolveWorkflowInstallPlan } from "./workflows/template-catalog.js";
import { decideWorkflowInstall } from "./workflows/install-decision.js";
import { upsertManagedBlock, renderHarnessContextBlock, AGENTS_MD_PATH } from "./agents-context/managed-block.js";
import { buildIssueFromSpec } from "./spec/issue-from-spec.js";
import { runSpecToIssuePipeline } from "./spec/spec-to-issue-pipeline.js";
import { IssueStateStore, RUN_ISSUE_LABEL, ensureRunIssue, findRunIssue, findRunIssueByImplementationIssue, findRunIssueByPullRequest, parseStateFromBody } from "./state/issue-store.js";
import { DEFAULT_CODING_AGENT, extractReferencedIssueNumbers, normalizeAgentLogin, pollForAgentAssignment, recordVerifiedAgentAssignment } from "./agent/assignment.js";
import { processReviewEvent, validateSelfHostingRef } from "./review/review-fix.js";
import type { StateStore } from "./state/state-store.js";
import { FileStateStore } from "./state/store.js";
import {
  PHASE_ORDER,
  classifyDeliveryPrMergeEffect,
  computeNextAction,
  bindDeliveryPullRequest,
  bindImplementationPullRequest,
  bindPullRequest,
  findGate,
  findPendingGateCleanup,
  findPendingGatePublication,
  finishIteration,
  findPassedMergeApprovalGate,
  formatCanonicalRunId,
  initRunState,
  needsGateReconciliation,
  needsDeliveryMergeReconciliation,
  recordDeliveryMergeEffect,
  reconcileInit,
  resolveGate,
  startIteration,
  transitionPhase,
  upsertDocumentationSnapshot,
  upsertGate,
} from "./state/state-machine.js";
import type { GateDecisionContext, GateType, HumanGateIssueRef, PhaseId, RunState } from "./state/types.js";
import { SCHEMA_VERSION } from "./state/types.js";
import { renderRunSnapshot, buildSnapshotFilename } from "./documentation/run-snapshot.js";
import { generateRunIndex, generateObsidianBase, parseFrontmatter, parseRunIndexEntry } from "./documentation/run-index.js";
import { validateDocumentationPath, validateLegacyDirectoryPath, validateSnapshotContent } from "./documentation/path-validator.js";
import { DEFAULT_RUN_DOCUMENTATION_CONFIG } from "./documentation/run-documentation-config.js";

/**
 * Minimal subset of `github` functions required by `cmdPersistRunDocumentation`.
 * Exported to allow integration tests to inject a stub adapter.
 */
export interface WriterGithubAdapter {
  preflightRunDocumentationWriter(repository: string, branch: string, recorderRepository?: string, expectedHarnessRef?: string, credentialAccessRole?: string): Promise<void>;
  getBranchSha(repository: string, branch: string): Promise<string>;
  verifyCommitOnBranch(repository: string, branch: string, expectedCommitSha: string): Promise<boolean>;
  createAtomicMultiFileCommit(
    repository: string,
    branch: string,
    buildFiles: (parentCommitSha: string) => Promise<Array<{ path: string; content: string }>>,
    commitMessage: string,
    maxRetries?: number,
    expectedPaths?: [string, string, string],
  ): Promise<string>;
  listDirectoryMarkdownFiles(repository: string, dirPath: string, ref: string): Promise<Array<{ name: string; path: string }>>;
  getFileContent(repository: string, path: string, ref: string): Promise<{ content: string; blobSha: string }>;
  getFileContentIfExists(repository: string, path: string, ref?: string): Promise<{ content: string; blobSha: string } | undefined>;
  /** Returns the SHA of the most recent commit on `branch` that touched `filePath`, or undefined if not found. */
  getLatestCommitForPath(repository: string, branch: string, filePath: string): Promise<string | undefined>;
  /**
   * Returns the set of file paths changed by a specific commit.
   * Used to verify that an adopted crash-after-push commit atomically contains
   * all three expected documentation paths. SPEC-012, TAC-11.
   */
  getCommitChangedPaths(repository: string, commitSha: string): Promise<Set<string>>;
  dispatchProcessAuditEnvelopeV1(recorderRepository: string, payload: {
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
  }): Promise<void>;
  confirmAuditEventInJournal(
    recorderRepository: string,
    journalDirectory: string,
    idempotencyKey: string,
    branch: string,
    maxAttempts?: number,
    retryDelayMs?: number,
  ): Promise<string>;
  createIssue(repository: string, opts: { title: string; body: string; labels?: string[] }): Promise<{ number: number; url: string }>;
  removeLabels(repository: string, issueNumber: number, labels: string[]): Promise<void>;
  addLabels(repository: string, issueNumber: number, labels: string[]): Promise<void>;
  closeIssue(repository: string, issueNumber: number): Promise<void>;
  ensureLabel(repository: string, name: string, opts?: { color?: string; description?: string }): Promise<void>;
}

interface StoreArgs {
  state?: string;
  repository?: string;
  runId?: string;
}

function storeOptions<T>(y: Argv<T>) {
  return y
    .option("state", { type: "string", describe: "Path to a local run-state JSON file (file backend)" })
    .option("repository", { type: "string", describe: "owner/repo, for the GitHub-issue backend" })
    .option("run-id", { type: "string", describe: "Run id, for the GitHub-issue backend" });
}

async function resolveExistingStore(argv: StoreArgs): Promise<StateStore> {
  if (argv.state) return new FileStateStore(argv.state);
  if (argv.repository && argv.runId) {
    const store = await findRunIssue(argv.repository, argv.runId);
    if (!store) {
      throw new Error(`no tracking issue found for run '${argv.runId}' in ${argv.repository}; run init first`);
    }
    return store;
  }
  throw new Error("provide either --state <path> or --repository + --run-id");
}

function printResult(command: string, result: unknown, nextAction: string): void {
  console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, command, result, nextAction }, null, 2));
}

function decisionContextFromArgs(argv: {
  scope?: string;
  criterion?: string[];
  risk?: string[];
  nonGoal?: string[];
  followUpAction?: string;
}): GateDecisionContext | undefined {
  const context: GateDecisionContext = {
    scope: argv.scope,
    criteria: argv.criterion,
    risks: argv.risk,
    nonGoals: argv.nonGoal,
    followUpAction: argv.followUpAction,
  };
  return Object.values(context).some((value) => value !== undefined) ? context : undefined;
}

async function retryPendingGateCleanup(store: StateStore, initial: RunState): Promise<RunState> {
  let state = initial;
  let pending = findPendingGateCleanup(state);
  while (pending) {
    if (!pending.decision) throw new Error(`gate '${pending.id}' has cleanupPending without a decision`);
    if (!pending.issue) throw new Error(`gate '${pending.id}' has cleanupPending without a tracking issue`);
    state = await postGateDecision(state, pending.id, {
      resolved: true,
      approved: pending.decision.approved,
      by: pending.decision.by,
      at: pending.decision.at,
      note: pending.decision.note,
    });
    await store.save(state);
    pending = findPendingGateCleanup(state);
  }
  return state;
}

async function retryPendingGatePublication(store: StateStore, initial: RunState): Promise<RunState> {
  let state = initial;
  let pending = findPendingGatePublication(state);
  while (pending) {
    state = await publishHumanGateIssue(state, pending.id, (checkpoint) => store.save(checkpoint));
    await store.save(state);
    pending = findPendingGatePublication(state);
  }
  return state;
}

interface CmdInitArgs {
  runId: string;
  repository: string;
  requirement: string;
  spec: string;
  issue?: number;
  branch?: string;
  state?: string;
  maxAutomaticIterations?: number;
  requirementPath?: string;
  specPath?: string;
  deliveryPullRequest?: number;
  deliveryHeadSha?: string;
  installBugWorkflow?: boolean;
  bugWorkflowRef?: string;
  bugWorkflowRepository?: string;
  bugWorkflowPath?: string;
  bugWorkflowReviewer?: string;
  bugWorkflowClaudeVersion?: string;
  bugWorkflowPreviewCommand?: string;
  installWorkflows?: string;
  workflowRef?: string;
  workflowRepository?: string;
  specPathGlob?: string;
  specToIssueDefaultBranch?: string;
  triggerLabel?: string;
  targetLabels?: string[];
  installAgentsContext?: boolean;
}

/**
 * SPEC-006 technical decision 6: project-specific parameters per catalog
 * entry are taken as CLI args here and embedded as `with:` inputs of the
 * rendered reference file, never baked into the reusable workflow itself.
 */
function buildWorkflowRenderOptions(name: string, argv: CmdInitArgs): Record<string, unknown> | undefined {
  if (name === "bug-triage") {
    return {
      harnessRef: argv.workflowRef,
      reusableRepository: argv.workflowRepository,
    };
  }
  if (name === "spec-to-issue") {
    return {
      harnessRef: argv.workflowRef,
      reusableRepository: argv.workflowRepository,
      specPathGlob: argv.specPathGlob,
      defaultBranch: argv.specToIssueDefaultBranch,
    };
  }
  if (name === "label-approval-bundling") {
    return {
      harnessRef: argv.workflowRef,
      reusableRepository: argv.workflowRepository,
      triggerLabel: argv.triggerLabel,
      targetLabels: argv.targetLabels,
    };
  }
  return undefined;
}

async function cmdInit(argv: CmdInitArgs): Promise<void> {
  // TAC-04: validate every requested-but-unknown catalog name up front,
  // before any file is written (including the legacy bug-workflow path).
  // TAC-07: also combines/de-dupes with --install-bug-workflow so the same
  // catalog entry is never processed twice.
  const combinedWorkflowNames = resolveWorkflowInstallPlan({
    installBugWorkflow: argv.installBugWorkflow,
    installWorkflows: argv.installWorkflows,
  });

  // SPEC-009 TAC-02: enforce the immutable-ref guard before any target file,
  // tracking issue, or other repository state can be mutated.
  for (const workflowName of combinedWorkflowNames) {
    const template = findWorkflowTemplate(workflowName)!;
    const usesLegacyBugOptions = workflowName === "bug-triage" && argv.installBugWorkflow;
    const sourceRepository = usesLegacyBugOptions
      ? argv.bugWorkflowRepository ?? "munichdeveloper/pi-spec-harness"
      : argv.workflowRepository ?? "munichdeveloper/pi-spec-harness";
    const harnessRef = usesLegacyBugOptions
      ? argv.bugWorkflowRef ?? template.defaultRef
      : argv.workflowRef ?? template.defaultRef;
    const validationError = validateSelfHostingRef(sourceRepository, argv.repository, harnessRef);
    if (validationError) throw new Error(validationError);
  }

  const initial = initRunState(argv);
  let store: StateStore;
  let state: RunState;

  if (argv.state) {
    store = new FileStateStore(argv.state);
    try {
      const existing = await store.load();
      state = reconcileInit(existing, argv);
    } catch {
      state = initial;
      await store.save(state);
    }
  } else {
    // ensureRunIssue finds an existing tracking issue or creates one and
    // persists `initial` into it verbatim; reconcileInit then either returns
    // that as-is (freshly created) or validates immutable fields match.
    store = await ensureRunIssue(argv.repository, argv.runId, initial);
    const existing = await store.load();
    state = reconcileInit(existing, argv);
  }

  let bugWorkflow:
    | undefined
    | {
      path: string;
      action: "created" | "updated" | "noop";
      commitSha?: string;
      harnessRef: string;
      repository: string;
    };

  if (argv.installBugWorkflow) {
    const path = argv.bugWorkflowPath ?? BUG_WORKFLOW_REFERENCE_PATH;
    const expectedContent = renderBugWorkflowReference({
      harnessRef: argv.bugWorkflowRef,
      reusableRepository: argv.bugWorkflowRepository,
      reviewer: argv.bugWorkflowReviewer,
      claudeCodeActionVersion: argv.bugWorkflowClaudeVersion,
      previewVerifyCommand: argv.bugWorkflowPreviewCommand,
    });
    const existing = await github.getFileContentIfExists(argv.repository, path);
    const decision = decideBugWorkflowInstall(existing?.content, expectedContent);

    if (decision === "conflict") {
      throw new Error(
        `workflow conflict at '${path}': existing file is not managed by pi-spec-harness; refusing to overwrite manual content`,
      );
    }

    if (decision === "create") {
      const commitSha = await github.createFileOnDefaultBranch(
        argv.repository,
        path,
        expectedContent,
        `ci: install bug workflow reference [harness:${argv.runId}]`,
      );
      bugWorkflow = {
        path,
        action: "created",
        commitSha,
        harnessRef: argv.bugWorkflowRef ?? DEFAULT_BUG_TRIAGE_WORKFLOW_REF,
        repository: argv.bugWorkflowRepository ?? "munichdeveloper/pi-spec-harness",
      };
    } else if (decision === "update-managed") {
      const commitSha = await github.updateFileOnDefaultBranch(
        argv.repository,
        path,
        expectedContent,
        existing!.blobSha,
        `ci: update bug workflow reference [harness:${argv.runId}]`,
      );
      bugWorkflow = {
        path,
        action: "updated",
        commitSha,
        harnessRef: argv.bugWorkflowRef ?? DEFAULT_BUG_TRIAGE_WORKFLOW_REF,
        repository: argv.bugWorkflowRepository ?? "munichdeveloper/pi-spec-harness",
      };
    } else {
      bugWorkflow = {
        path,
        action: "noop",
        harnessRef: argv.bugWorkflowRef ?? DEFAULT_BUG_TRIAGE_WORKFLOW_REF,
        repository: argv.bugWorkflowRepository ?? "munichdeveloper/pi-spec-harness",
      };
    }
  }

  // SPEC-006: generic install for any additionally requested catalog
  // entries. "bug-triage" is skipped here if --install-bug-workflow already
  // handled it above, so the same catalog entry is never written twice in a
  // single invocation (TAC combined-flags test).
  const workflows: Record<
    string,
    {
      path: string;
      action: "created" | "updated" | "noop";
      commitSha?: string;
      harnessRef: string;
      repository: string;
    }
  > = {};
  const conflicts: string[] = [];

  const namesToInstallGenerically = combinedWorkflowNames.filter(
    (name) => !(name === "bug-triage" && argv.installBugWorkflow),
  );

  for (const name of namesToInstallGenerically) {
    const template = findWorkflowTemplate(name)!;
    const renderOptions = buildWorkflowRenderOptions(name, argv);
    const expectedContent = template.renderReference(renderOptions);
    const existing = await github.getFileContentIfExists(argv.repository, template.targetPath);
    const decision = decideWorkflowInstall(existing?.content, expectedContent, template.marker);
    const harnessRefUsed = (renderOptions?.harnessRef as string | undefined) ?? template.defaultRef;
    const repositoryUsed = (renderOptions?.reusableRepository as string | undefined) ?? "munichdeveloper/pi-spec-harness";

    if (decision === "conflict") {
      // TAC-06: no file write; caller-visible via result.conflicts[].
      conflicts.push(template.targetPath);
      continue;
    }

    if (decision === "create") {
      const commitSha = await github.createFileOnDefaultBranch(
        argv.repository,
        template.targetPath,
        expectedContent,
        `ci: install ${name} workflow reference [harness:${argv.runId}]`,
      );
      workflows[name] = { path: template.targetPath, action: "created", commitSha, harnessRef: harnessRefUsed, repository: repositoryUsed };
    } else if (decision === "update-managed") {
      const commitSha = await github.updateFileOnDefaultBranch(
        argv.repository,
        template.targetPath,
        expectedContent,
        existing!.blobSha,
        `ci: update ${name} workflow reference [harness:${argv.runId}]`,
      );
      workflows[name] = { path: template.targetPath, action: "updated", commitSha, harnessRef: harnessRefUsed, repository: repositoryUsed };
    } else {
      workflows[name] = { path: template.targetPath, action: "noop", harnessRef: harnessRefUsed, repository: repositoryUsed };
    }
  }

  // SPEC-008: independent, optional managed context block in AGENTS.md.
  let agentsContext:
    | undefined
    | {
      path: string;
      action: "created" | "updated" | "noop" | "conflict";
      commitSha?: string;
    };

  if (argv.installAgentsContext) {
    const blockContent = renderHarnessContextBlock({ repository: argv.repository });
    const existing = await github.getFileContentIfExists(argv.repository, AGENTS_MD_PATH);
    const upserted = upsertManagedBlock(existing?.content, blockContent);

    if (upserted.decision === "conflict") {
      agentsContext = { path: AGENTS_MD_PATH, action: "conflict" };
      conflicts.push(AGENTS_MD_PATH);
    } else if (upserted.decision === "noop") {
      agentsContext = { path: AGENTS_MD_PATH, action: "noop" };
    } else if (upserted.decision === "create") {
      const commitSha = await github.createFileOnDefaultBranch(
        argv.repository,
        AGENTS_MD_PATH,
        upserted.content,
        `docs: install harness context block [harness:${argv.runId}]`,
      );
      agentsContext = { path: AGENTS_MD_PATH, action: "created", commitSha };
    } else {
      // update-managed or insert-appended: both require an existing blob SHA.
      const commitSha = await github.updateFileOnDefaultBranch(
        argv.repository,
        AGENTS_MD_PATH,
        upserted.content,
        existing!.blobSha,
        `docs: update harness context block [harness:${argv.runId}]`,
      );
      agentsContext = { path: AGENTS_MD_PATH, action: "updated", commitSha };
    }
  }

  printResult(
    "init",
    { location: argv.state ?? store.issueRef?.url, state, bugWorkflow, workflows, conflicts, agentsContext },
    computeNextAction(state).detail,
  );
}

async function cmdStatus(argv: StoreArgs): Promise<void> {
  const store = await resolveExistingStore(argv);
  const state = await store.load();
  const next = computeNextAction(state);
  printResult("status", { state, nextAction: next }, next.detail);
}

async function cmdResume(argv: StoreArgs): Promise<void> {
  // resume never mutates state on its own; it only recomputes and, for open
  // human gates, polls the backing GitHub issue for a resolved decision.
  const store = await resolveExistingStore(argv);
  let state = await store.load();
  state = await retryPendingGatePublication(store, state);
  state = await retryPendingGateCleanup(store, state);
  const next = computeNextAction(state);

  if (next.action === "await-human-gate" && next.gate?.issue) {
    const decision = await checkHumanGateIssue(state, next.gate.id);
    if (decision.resolved) {
      // TAC-06: persist the decision state BEFORE running comment/label cleanup.
      const decided = computeGateDecision(state, next.gate.id, decision);
      await store.save(decided);
      // TAC-07: cleanup is idempotent and can be retried if it fails.
      state = await postGateDecision(decided, next.gate.id, decision);
      await store.save(state);
      const updatedNext = computeNextAction(state);
      printResult("resume", { state, nextAction: updatedNext }, updatedNext.detail);
      return;
    }
  }

  printResult("resume", { state, nextAction: next }, next.detail);
}

/**
 * Persist the run documentation snapshot as Markdown in the target repository.
 * Writes the snapshot, run index, and Obsidian base to the configured paths,
 * then records the persisted checkpoint in the run state.
 * SPEC-012, decision 4–7.
 */
export async function cmdPersistRunDocumentation(argv: {
  repository: string;
  issueNumber: number;
  generatedDirectory?: string;
  legacyDirectories?: string[];
  indexPath?: string;
  obsidianBasePath?: string;
  branch?: string;
  harnessVersion?: string;
  auditRecorderRepo?: string;
  auditJournalPath?: string;
  /**
   * The access role of the credential that will be used to dispatch the
   * process-audit event.  When the audit recorder is in a different repository,
   * this must be a cross-repository-capable role such as
   * `GITHUB_PERSONAL_ACCESS_TOKEN` or `GITHUB_APP_USER_AUTHORIZATION`.
   * Defaults to `GITHUB_TOKEN` (repository-scoped; cross-repo dispatch
   * is rejected when this is the active role).
   */
  auditAccessRole?: string;
  /**
   * The exact immutable harness ref (e.g. `abc1234` or `v1.2.3`) that the
   * installed process-audit receiver workflow must reference.  Passed
   * directly to `preflightRunDocumentationWriter` so the preflight can
   * attest the receiver is pinned to the configured ref rather than any
   * arbitrary or mutable tag/branch.
   */
  auditReceiverRef?: string;
  /** For testing only: inject a fake GitHub adapter to avoid live API calls. */
  _githubAdapter?: WriterGithubAdapter;
  /** For testing only: inject a store factory to use an in-memory state store. */
  _storeFactory?: (repository: string, issueNumber: number) => import("./state/state-store.js").StateStore & { issueRef?: { repository: string; number: number; url: string } };
}): Promise<void> {
  const { repository, issueNumber, branch = "main" } = argv;
  const gh: WriterGithubAdapter = argv._githubAdapter ?? github;
  const generatedDirectory = argv.generatedDirectory ?? DEFAULT_RUN_DOCUMENTATION_CONFIG.generatedDirectory;
  const legacyDirectories = argv.legacyDirectories ?? DEFAULT_RUN_DOCUMENTATION_CONFIG.legacyDirectories;
  // Validate each legacy directory path before any I/O (SPEC-012 Fix-4).
  for (const legacyDir of legacyDirectories) {
    validateLegacyDirectoryPath(legacyDir);
  }
  const indexPath = argv.indexPath ?? DEFAULT_RUN_DOCUMENTATION_CONFIG.indexPath;
  const obsidianBasePath = argv.obsidianBasePath ?? DEFAULT_RUN_DOCUMENTATION_CONFIG.obsidianBasePath;
  // Audit recorder defaults to the same repository as the tracking issue.
  const auditRecorderRepo = argv.auditRecorderRepo ?? repository;
  const auditJournalPath = argv.auditJournalPath ?? "docs/process-audit/journal";
  const auditAccessRole = argv.auditAccessRole;
  const auditReceiverRef = argv.auditReceiverRef;

  const store = argv._storeFactory ? argv._storeFactory(repository, issueNumber) as IssueStateStore : new IssueStateStore(repository, issueNumber);
  let state = await store.load();

  // ---- Idempotent no-op guard (SPEC-012 TAC-11) ----
  //
  // If the checkpoint says "persisted" with both a commitSha and an
  // auditConfirmedAt, re-confirm against origin and the audit journal before
  // accepting the no-op. This prevents a commit-success/state-save-failure
  // from permanently hiding a missing origin effect or an audit gap
  // (SPEC-012 §3 item 3 & 4 / finding #2).
  if (
    state.documentationSnapshot?.status === "persisted" &&
    state.documentationSnapshot.commitSha &&
    state.documentationSnapshot.auditConfirmedAt
  ) {
    const snap = state.documentationSnapshot;
    const commitOnOrigin = await gh.verifyCommitOnBranch(repository, branch, snap.commitSha!);
    let auditInJournal = false;
    if (commitOnOrigin) {
      // Only bother checking the journal if the commit is confirmed; a failed
      // origin check means we must re-run regardless.
      try {
        // Attempt a single quick confirmation (1 attempt, 0 delay).
        await gh.confirmAuditEventInJournal(
          auditRecorderRepo,
          auditJournalPath,
          snap.auditIdempotencyKey,
          branch,
          1,
          0,
        );
        auditInJournal = true;
      } catch {
        // Audit not confirmed in journal — fall through to re-deliver.
      }
    }
    if (commitOnOrigin && auditInJournal) {
      const next = computeNextAction(state);
      printResult(
        "persist-run-documentation",
        { skipped: "already-persisted", documentationSnapshot: snap, nextAction: next },
        next.detail,
      );
      return;
    }
    // At least one of commit-on-origin or audit-in-journal failed; fall through
    // to re-execute the publishing / audit phases from the persisted keys.
  }

  const next = computeNextAction(state);
  if (next.action !== "persist-run-documentation") {
    throw new Error(`run '${state.runId}' is not ready for documentation persistence: ${next.detail}`);
  }

  // ---- Capability preflight (SPEC-012 §11 / TAC-17) ----
  //
  // Verify branch accessibility, contents-write permission, and that the
  // configured audit recorder is reachable. Preflight runs before any state
  // is mutated; a missing capability produces a concrete error. The recorder
  // check is NOT deferred (SPEC-012 §8 / TAC-17 "fehlenden Auditvertrag").
  await gh.preflightRunDocumentationWriter(repository, branch, auditRecorderRepo, auditReceiverRef, auditAccessRole);

  const harnessVersion = argv.harnessVersion ?? "unknown";

  const trackingIssue: HumanGateIssueRef = {
    repository,
    number: issueNumber,
    url: `https://github.com/${repository}/issues/${issueNumber}`,
  };

  // ---- Phase 1: Build or reuse the prepared checkpoint ----
  //
  // `generatedAt`, paths, and idempotency keys must be persisted in state
  // BEFORE the first external write so that every retry produces byte-identical
  // content. If a `prepared` or `publishing` checkpoint already exists, reuse
  // its keys and timestamps rather than generating new ones.

  const existing = state.documentationSnapshot;
  // Also treat a `persisted` checkpoint that failed re-confirmation as resumable.
  const isResuming = existing &&
    (existing.status === "prepared" || existing.status === "publishing" || existing.status === "persisted");

  const generatedAt = isResuming ? existing.generatedAt : new Date().toISOString();
  const idempotencyKey = isResuming
    ? existing.idempotencyKey
    : `persist-run-doc-${state.runId}-${issueNumber}`;
  const auditIdempotencyKey = isResuming
    ? existing.auditIdempotencyKey
    : `audit-run-doc-${state.runId}-${issueNumber}`;
  const snapshotFilename = buildSnapshotFilename(state.runId, state.spec);
  const snapshotPath = isResuming ? existing.path : `${generatedDirectory}/${snapshotFilename}`;

  // Validate all three destination paths before touching any state.
  validateDocumentationPath(snapshotPath);
  validateDocumentationPath(indexPath);
  validateDocumentationPath(obsidianBasePath);

  // Resolve HEAD SHA of the default branch as the source reference.
  const sourceHeadSha = isResuming ? existing.sourceHeadSha : await gh.getBranchSha(repository, branch);

  if (!isResuming) {
    // Pre-compute all three output file contents (deterministic: snapshot
    // depends only on state; index/base depend on existing origin entries at
    // sourceHeadSha). Hashing all three and persisting them enables
    // crash-after-push reconciliation that can verify the ATOMIC three-file
    // commit landed — not just that the snapshot path was touched by some
    // partial or concurrent commit. SPEC-012, TAC-11.
    const preparedSnapshotContent = renderRunSnapshot({
      state,
      trackingIssue,
      repositoryDefaultBranch: branch,
      harnessVersion: argv.harnessVersion ?? "unknown",
      generatedAt,
    });

    // Read existing entries from origin at sourceHeadSha so the index/base
    // hashes are deterministic for the same parent state. readAllRunEntries is
    // a hoisted function declaration defined later in this function body.
    const preparedExistingEntries = await readAllRunEntries(sourceHeadSha, snapshotPath);
    const preparedNewEntry = parseRunIndexEntry(snapshotPath, preparedSnapshotContent);
    if (preparedNewEntry) preparedExistingEntries.push(preparedNewEntry);
    const preparedIndexContent = generateRunIndex(preparedExistingEntries, generatedAt);
    const preparedObsidianContent = generateObsidianBase(preparedExistingEntries, generatedAt);

    const preparedContentHashes: Record<string, string> = {
      [snapshotPath]: createHash("sha256").update(preparedSnapshotContent, "utf8").digest("hex"),
      [indexPath]: createHash("sha256").update(preparedIndexContent, "utf8").digest("hex"),
      [obsidianBasePath]: createHash("sha256").update(preparedObsidianContent, "utf8").digest("hex"),
    };

    // Persist the `prepared` checkpoint BEFORE the first external write.
    state = upsertDocumentationSnapshot(state, {
      schemaVersion: 1,
      status: "prepared",
      idempotencyKey,
      path: snapshotPath,
      indexPath,
      obsidianBasePath,
      generatedAt,
      sourceHeadSha,
      contentHashes: preparedContentHashes,
      auditIdempotencyKey,
    });
    await store.save(state);
  }

  // Constants used in the delivery failure handler below (TAC-13).
  const MAX_DOC_DELIVERY_FAILURES = 3;
  const DELIVERY_FAILED_GATE_ID = "run-documentation-delivery-failed";

  // ---- Phases 2 & 3: Atomic commit + REQ-005 audit delivery ----
  //
  // Both phases are wrapped in a single try-catch so that ANY failure —
  // conflict exhaustion, origin-verification failure, dispatch error, or
  // journal confirmation timeout — increments the delivery failure counter
  // and opens exactly one Human Gate after three consecutive failures
  // (SPEC-012 §9 / TAC-13, finding #3).

  let commitSha: string;
  let auditConfirmedAt: string;

  try {
    // ---- Phase 2: Atomic three-file commit ----
    //
    // If resuming a `publishing` checkpoint with a commit already confirmed
    // on origin, skip the write phase and go straight to audit.
    if (
      (state.documentationSnapshot?.status === "publishing" ||
        state.documentationSnapshot?.status === "persisted") &&
      state.documentationSnapshot.commitSha
    ) {
      // Resume: verify the commit is still reachable from origin. If not,
      // the branch may have been force-pushed; re-commit to recover.
      const onOrigin = await gh.verifyCommitOnBranch(
        repository,
        branch,
        state.documentationSnapshot.commitSha,
      );
      commitSha = onOrigin
        ? state.documentationSnapshot.commitSha
        : await performAtomicDocCommit();
    } else if (
      state.documentationSnapshot?.status === "prepared" &&
      state.documentationSnapshot.contentHashes?.[snapshotPath]
    ) {
      // Crash-after-push reconciliation (SPEC-012, TAC-11): the `prepared`
      // checkpoint has no commitSha, but a prior attempt may have already
      // landed the three-file atomic commit. To safely adopt it we must
      // verify ALL THREE expected output files match their stored hashes —
      // not just the snapshot. This prevents a concurrent or partial commit
      // that touches only the snapshot path from being falsely adopted.
      const hashes = state.documentationSnapshot.contentHashes;
      const expectedSnapshotHash = hashes[snapshotPath];
      const expectedIndexHash = hashes[indexPath];
      const expectedBaseHash = hashes[obsidianBasePath];

      const [originSnapshot, originIndex, originBase] = await Promise.all([
        gh.getFileContentIfExists(repository, snapshotPath),
        expectedIndexHash ? gh.getFileContentIfExists(repository, indexPath) : Promise.resolve(undefined),
        expectedBaseHash ? gh.getFileContentIfExists(repository, obsidianBasePath) : Promise.resolve(undefined),
      ]);

      const snapshotHashMatches = originSnapshot &&
        createHash("sha256").update(originSnapshot.content, "utf8").digest("hex") === expectedSnapshotHash;
      const indexHashMatches = !expectedIndexHash ||
        (originIndex &&
          createHash("sha256").update(originIndex.content, "utf8").digest("hex") === expectedIndexHash);
      const baseHashMatches = !expectedBaseHash ||
        (originBase &&
          createHash("sha256").update(originBase.content, "utf8").digest("hex") === expectedBaseHash);

      if (snapshotHashMatches && indexHashMatches && baseHashMatches) {
        // All three origin files match the prepared hashes. Find the latest
        // commit that touched the snapshot path and verify it also contains
        // the index and base paths (confirming the three-file atomicity).
        const candidateSha = await gh.getLatestCommitForPath(repository, branch, snapshotPath);
        if (candidateSha) {
          const commitPaths = await gh.getCommitChangedPaths(repository, candidateSha);
          const hasAllThree =
            commitPaths.has(snapshotPath) &&
            commitPaths.has(indexPath) &&
            commitPaths.has(obsidianBasePath);
          const isReachable = await gh.verifyCommitOnBranch(repository, branch, candidateSha);
          if (hasAllThree && isReachable) {
            commitSha = candidateSha;
          } else {
            // Commit does not contain all three paths or is not reachable.
            commitSha = await performAtomicDocCommit();
          }
        } else {
          commitSha = await performAtomicDocCommit();
        }
      } else {
        commitSha = await performAtomicDocCommit();
      }
    } else {
      commitSha = await performAtomicDocCommit();
    }

    // Save `publishing` checkpoint (commit confirmed on origin) before audit.
    state = upsertDocumentationSnapshot(state, {
      schemaVersion: 1,
      status: "publishing",
      idempotencyKey,
      path: snapshotPath,
      indexPath,
      obsidianBasePath,
      generatedAt,
      sourceHeadSha,
      contentHashes: state.documentationSnapshot?.contentHashes,
      commitSha,
      auditIdempotencyKey,
    });
    await store.save(state);

    // ---- Phase 3: Audit delivery via REQ-005 envelope-v1 (SPEC-012 §8) ----
    //
    // Deliver a DOCUMENTATION_UPDATE event to the configured recorder via
    // `repository_dispatch` with the SPEC-005 envelope-v1 payload. Only after
    // the idempotency key is confirmed in the recorder's default-branch journal
    // is `auditConfirmedAt` recorded in run state. A mutable issue comment is
    // NOT an acceptable substitute for the durable journal entry (finding #1).
    await gh.dispatchProcessAuditEnvelopeV1(
      auditRecorderRepo,
      {
        schema_version: 1,
        occurred_at: generatedAt,
        process_instance: formatCanonicalRunId(repository, issueNumber).processInstance,
        idempotency_key: auditIdempotencyKey,
        process_code: "DOCUMENTATION_UPDATE",
        actor: "GITHUB_ACTIONS",
        access_role: "GITHUB_ACTIONS_TOKEN",
        supporting_access_roles: [],
        outcome: "SUCCEEDED",
        repository,
        artifact: commitSha,
        correlation_ids: [state.runId, `${repository}#${issueNumber}`],
        evidence: [
          `https://github.com/${repository}/issues/${issueNumber}`,
          `https://github.com/${repository}/commit/${commitSha}`,
        ],
        reason: `Run documentation persisted for run ${state.runId}.`,
        description: `The harness run-documentation-finalizer committed the structured run snapshot at ${snapshotPath}.`,
      },
    );

    // Poll the recorder's journal until the idempotency key appears on the
    // default branch. This is the "confirmed delivery" step from SPEC-005 §4.
    auditConfirmedAt = await gh.confirmAuditEventInJournal(
      auditRecorderRepo,
      auditJournalPath,
      auditIdempotencyKey,
      branch,
    );
  } catch (deliveryErr) {
    // Any write-or-audit failure: increment the delivery failure counter and
    // open exactly one Human Gate after reaching the configured threshold.
    const prevCount = state.documentationSnapshot?.deliveryFailureCount ?? 0;
    const newCount = prevCount + 1;
    // Preserve all existing checkpoint fields; only update status + counter.
    state = upsertDocumentationSnapshot(state, {
      schemaVersion: 1,
      status: state.documentationSnapshot?.status ?? "prepared",
      idempotencyKey,
      path: snapshotPath,
      indexPath,
      obsidianBasePath,
      generatedAt,
      sourceHeadSha,
      ...(state.documentationSnapshot?.commitSha
        ? { commitSha: state.documentationSnapshot.commitSha }
        : {}),
      auditIdempotencyKey,
      deliveryFailureCount: newCount,
    });
    await store.save(state);

    if (newCount >= MAX_DOC_DELIVERY_FAILURES && !findGate(state, DELIVERY_FAILED_GATE_ID) && store.issueRef) {
      const gateQuestion =
        "The run documentation could not be persisted or audited after three attempts. Please review and retry or close manually.";
      state = upsertGate(state, {
        id: DELIVERY_FAILED_GATE_ID,
        type: "human",
        question: gateQuestion,
      });
      state = prepareHumanGateIssue({
        runState: state,
        gateId: DELIVERY_FAILED_GATE_ID,
        title: `[Harness] Run documentation delivery failed after ${newCount} attempts`,
        question: gateQuestion,
        context: [
          `runId: ${state.runId}`,
          `repository: ${repository}`,
          `snapshotPath: ${snapshotPath}`,
          `auditRecorderRepo: ${auditRecorderRepo}`,
          `auditJournalPath: ${auditJournalPath}`,
          `failureError: ${deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr)}`,
        ],
        decisionContext: undefined,
        runIssue: store.issueRef,
      });
      await store.save(state);
      // Best-effort: attempt to publish the gate as a GitHub issue; if this fails the
      // gate is still persisted in state and can be published on the next invocation.
      try {
        state = await publishHumanGateIssue(state, DELIVERY_FAILED_GATE_ID, (checkpoint) => store.save(checkpoint));
        await store.save(state);
      } catch {
        // Gate state is already saved; delivery failure is the primary error.
      }
    }
    throw deliveryErr;
  }

  // Transition to `persisted` only after the audit event is confirmed in the
  // recorder's default-branch journal.
  state = upsertDocumentationSnapshot(state, {
    schemaVersion: 1,
    status: "persisted",
    idempotencyKey,
    path: snapshotPath,
    indexPath,
    obsidianBasePath,
    generatedAt,
    sourceHeadSha,
    commitSha,
    auditIdempotencyKey,
    auditConfirmedAt,
  });
  await store.save(state);

  const following = computeNextAction(state);
  printResult(
    "persist-run-documentation",
    {
      snapshotPath,
      indexPath,
      obsidianBasePath,
      commitSha,
      sourceHeadSha,
      auditConfirmedAt,
      documentationSnapshot: state.documentationSnapshot,
      nextAction: following,
    },
    following.detail,
  );

  // --------------------------------------------------------------------------
  // Inner helper: read all existing run index entries from generatedDirectory
  // and all configured legacyDirectories, deduplicated by path. Files with an
  // unknown schema_version cause a hard failure (fail-closed, SPEC-012 §10).
  // --------------------------------------------------------------------------
  async function readAllRunEntries(
    parentCommitSha: string,
    skipPath: string,
  ): Promise<Array<import("./documentation/run-index.js").RunIndexEntry>> {
    const allEntries: Array<import("./documentation/run-index.js").RunIndexEntry> = [];

    const dirsToScan = [generatedDirectory, ...legacyDirectories];
    const seenPaths = new Set<string>();

    for (const dir of dirsToScan) {
      const files = await gh.listDirectoryMarkdownFiles(repository, dir, parentCommitSha);
      for (const file of files) {
        if (file.path === skipPath) continue;           // will be replaced by new content
        if (file.path.endsWith("-notes.md")) continue; // human-managed notes, not run docs
        if (seenPaths.has(file.path)) continue;
        seenPaths.add(file.path);

        // Network reads propagate; only swallow "not found" for entire directories
        // (handled by listDirectoryMarkdownFiles returning []).
        const { content } = await gh.getFileContent(repository, file.path, parentCommitSha);

        // Fail closed on unknown schema version: SPEC-012 §10 / TAC-10.
        const fm = parseFrontmatter(content);
        if (fm && "schema_version" in fm && fm["schema_version"] !== 1) {
          throw new Error(
            `run documentation file '${file.path}' has unknown schema_version '${fm["schema_version"]}'; ` +
            `aborting to avoid silently dropping it from regenerated views`,
          );
        }

        const entry = parseRunIndexEntry(file.path, content);
        if (entry) allEntries.push(entry);
        // Files without a run_id (e.g. non-run markdown) are silently skipped.
      }
    }
    return allEntries;
  }

  // --------------------------------------------------------------------------
  // Inner helper: perform one transactional three-file documentation commit
  // using the Git Data API (SPEC-012 §7 / TAC-10–12). Retries up to 3 times
  // on non-fast-forward conflicts; verifies the commit is on origin after push.
  // --------------------------------------------------------------------------
  async function performAtomicDocCommit(): Promise<string> {
    const commitMessage = `docs(harness): persist run documentation snapshot for ${state.runId}`;

    const expectedPaths: [string, string, string] = [snapshotPath, indexPath, obsidianBasePath];

    const sha = await gh.createAtomicMultiFileCommit(
      repository,
      branch,
      async (parentCommitSha) => {
        // Re-render snapshot content (deterministic; same state + generatedAt
        // always produces byte-identical output per SPEC-012 TAC-06).
        const snapshotContent = renderRunSnapshot({
          state,
          trackingIssue,
          repositoryDefaultBranch: branch,
          harnessVersion,
          generatedAt,
        });

        // Validate snapshot content for PII / secrets / evidence URLs.
        validateSnapshotContent(snapshotContent);

        // Read existing run entries from generatedDirectory AND all configured
        // legacyDirectories so the index is always complete and cumulative.
        // Files with unknown schema versions cause a hard failure (fail-closed).
        const allEntries = await readAllRunEntries(parentCommitSha, snapshotPath);

        // Add the new/updated snapshot entry.
        const newEntry = parseRunIndexEntry(snapshotPath, snapshotContent);
        if (newEntry) allEntries.push(newEntry);

        const indexContent = generateRunIndex(allEntries, generatedAt);
        const obsidianContent = generateObsidianBase(allEntries, generatedAt);

        // SPEC-012 Fix 1: persist updated contentHashes BEFORE each push
        // attempt. On conflict/retry the index/base bytes may differ from the
        // hashes saved in the `prepared` checkpoint (because buildFiles() is
        // re-invoked with the new parentCommitSha). Without updating the
        // checkpoint here, a crash-after-push scenario on the second+ attempt
        // would leave the reconciler comparing origin bytes against stale
        // prepared hashes, causing it to reject the correctly landed commit and
        // create a duplicate.
        const updatedHashes: Record<string, string> = {
          [snapshotPath]: createHash("sha256").update(snapshotContent, "utf8").digest("hex"),
          [indexPath]: createHash("sha256").update(indexContent, "utf8").digest("hex"),
          [obsidianBasePath]: createHash("sha256").update(obsidianContent, "utf8").digest("hex"),
        };
        state = upsertDocumentationSnapshot(state, {
          schemaVersion: 1,
          status: "prepared",
          idempotencyKey,
          path: snapshotPath,
          indexPath,
          obsidianBasePath,
          generatedAt,
          sourceHeadSha,
          contentHashes: updatedHashes,
          auditIdempotencyKey,
        });
        await store.save(state);

        return [
          { path: snapshotPath, content: snapshotContent },
          { path: indexPath, content: indexContent },
          { path: obsidianBasePath, content: obsidianContent },
        ];
      },
      commitMessage,
      3,
      expectedPaths,
    );

    // Verify the commit landed on origin/<branch> (exact or as ancestor).
    const confirmed = await gh.verifyCommitOnBranch(repository, branch, sha);
    if (!confirmed) {
      throw new Error(
        `documentation commit ${sha} was not confirmed on origin/${branch}; aborting`,
      );
    }

    return sha;
  }
}

async function cmdAdvance(argv: StoreArgs): Promise<void> {
  const store = await resolveExistingStore(argv);
  const state = await store.load();
  const next = computeNextAction(state);
  if (next.action !== "advance-phase") {
    throw new Error(`run '${state.runId}' cannot advance: ${next.detail}`);
  }

  const currentIndex = PHASE_ORDER.indexOf(state.phase);
  const nextPhase = PHASE_ORDER[currentIndex + 1];
  if (!nextPhase) {
    throw new Error(`run '${state.runId}' has no phase after '${state.phase}'`);
  }

  const advanced = transitionPhase(state, nextPhase);
  await store.save(advanced);
  if (nextPhase === "complete" && store.issueRef) {
    await github.closeIssue(
      store.issueRef.repository,
      store.issueRef.number,
      `Harness: Run \`${advanced.runId}\` ist abgeschlossen (Phase \`complete\`).`,
    );
  }
  const following = computeNextAction(advanced);
  printResult("advance", { state: advanced, nextAction: following }, following.detail);
}

async function cmdGateOpen(
  argv: StoreArgs & {
    gateId: string;
    type: GateType;
    title: string;
    question: string;
    context?: string[];
    scope?: string;
    criterion?: string[];
    risk?: string[];
    nonGoal?: string[];
    followUpAction?: string;
  },
): Promise<void> {
  const store = await resolveExistingStore(argv);
  let state = await store.load();
  const decisionContext = decisionContextFromArgs(argv);
  state = upsertGate(state, { id: argv.gateId, type: argv.type, question: argv.question, context: decisionContext });
  if (decisionContext) state = resolveGate(state, argv.gateId, { context: decisionContext });
  if (argv.type === "human") {
    if (!store.issueRef) {
      throw new Error(
        "human gates require the GitHub-issue backend (--repository + --run-id); the file backend has no tracking issue to attach the gate to",
      );
    }
    state = prepareHumanGateIssue({
      runState: state,
      gateId: argv.gateId,
      title: argv.title,
      question: argv.question,
      context: argv.context ?? [],
      decisionContext,
      runIssue: store.issueRef,
    });
    // TAC-03: the prepared checkpoint is canonical before any label/comment write.
    await store.save(state);
    state = await publishHumanGateIssue(state, argv.gateId, (checkpoint) => store.save(checkpoint));
  }
  await store.save(state);
  const next = computeNextAction(state);
  printResult("gate-open", { state, nextAction: next }, next.detail);
}

async function cmdGateResolve(
  argv: StoreArgs & { gateId: string; result: "passed" | "failed"; evidence?: string[] },
): Promise<void> {
  const store = await resolveExistingStore(argv);
  let state = await store.load();
  const gate = findGate(state, argv.gateId);
  if (gate?.type === "human") {
    throw new Error(
      `human gate '${argv.gateId}' can only be resolved by a decision label and harness resume`,
    );
  }
  state = resolveGate(state, argv.gateId, { result: argv.result, evidence: argv.evidence });
  await store.save(state);
  const next = computeNextAction(state);
  printResult("gate-resolve", { state, nextAction: next }, next.detail);
}

async function cmdPhase(argv: StoreArgs & { phase: PhaseId }): Promise<void> {
  const store = await resolveExistingStore(argv);
  let state = await store.load();
  state = transitionPhase(state, argv.phase);
  await store.save(state);

  if (argv.phase === "complete" && store.issueRef) {
    await github.closeIssue(
      store.issueRef.repository,
      store.issueRef.number,
      `Harness: Run \`${state.runId}\` ist abgeschlossen (Phase \`complete\`).`,
    );
  }

  // Auto-label implementation issue for Copilot assignment when phase becomes "implementation"
  if (argv.phase === "implementation" && state.issue && store.issueRef) {
    try {
      await github.addLabels(store.issueRef.repository, state.issue, ["ai:allowed", "status:ready"]);
    } catch (err) {
      // Non-fatal: if labeling fails (e.g., issue doesn't exist yet), just log and continue
      console.warn(`Warning: could not add Copilot labels to issue ${state.issue}: ${err}`);
    }
  }

  const next = computeNextAction(state);
  printResult("phase", { state, nextAction: next }, next.detail);
}

async function cmdPrBind(
  argv: StoreArgs & { pullRequest: number; headSha: string },
): Promise<void> {
  const store = await resolveExistingStore(argv);
  let state = await store.load();
  state = bindPullRequest(state, argv.pullRequest, argv.headSha);
  await store.save(state);
  const next = computeNextAction(state);
  printResult("pr-bind", { state, nextAction: next }, next.detail);
}

async function cmdGateAcknowledge(argv: StoreArgs & { gateId: string; note: string }): Promise<void> {
  const store = await resolveExistingStore(argv);
  let state = await store.load();
  state = await acknowledgeRejectedHumanGate(state, argv.gateId, argv.note);
  await store.save(state);
  const next = computeNextAction(state);
  printResult("gate-acknowledge", { state, nextAction: next }, next.detail);
}

async function cmdNote(argv: StoreArgs & { text: string }): Promise<void> {
  const store = await resolveExistingStore(argv);
  const state = await store.load();
  const notes = [...(state.notes ?? []), `${new Date().toISOString()} ${argv.text}`];
  const next = { ...state, notes, updatedAt: new Date().toISOString() };
  await store.save(next);
  printResult("note", { state: next }, `Note recorded on run '${next.runId}'.`);
}

async function cmdIssueCreate(
  argv: StoreArgs & {
    title?: string;
    body?: string;
    bodyFile?: string;
    fromSpecPath?: string;
    labels?: string[];
    assignee?: string;
  },
): Promise<void> {
  const store = await resolveExistingStore(argv);
  let state = await store.load();

  let title = argv.title;
  let body = argv.body;

  if (argv.fromSpecPath) {
    // SPEC-007 TAC-03: --from-spec-path uses the same buildIssueFromSpec()
    // logic as the reactive spec-to-issue pipeline, so both paths produce
    // identical title/body for the same spec.
    const specContent = await readFile(argv.fromSpecPath, "utf-8");
    const built = buildIssueFromSpec(specContent, { specPath: argv.fromSpecPath });
    title = built.title;
    body = built.body;
  } else if (argv.bodyFile) {
    body = await readFile(argv.bodyFile, "utf-8");
  }

  if (!title) {
    throw new Error("--title or --from-spec-path is required");
  }
  if (!body) {
    throw new Error("--body or --body-file or --from-spec-path is required");
  }

  // If spec is provided in the state and no assignee override, read from spec frontmatter
  let assignee = argv.assignee;
  if (!assignee && state.spec && argv.repository) {
    try {
      assignee = await getSpecAssignee(argv.repository, `${state.spec}-*.md`);
    } catch {
      // Fall back to copilot if spec frontmatter cannot be read
      assignee = "@github-copilot";
    }
  }
  assignee = assignee || "@github-copilot";

  // Create the issue with a note if it's for @github-copilot
  let bodyWithNote = body;
  if (assignee === "@github-copilot") {
    bodyWithNote = [
      `_Intended for: ${assignee}_\n`,
      body,
    ].join("\n");
  }

  const issueRef = await github.createIssue(argv.repository || "", {
    title,
    body: bodyWithNote,
    labels: argv.labels,
  });

  // SPEC-002 deliberately leaves Coding Agent assignment unchanged. The
  // verified Agent Assignment API belongs to SPEC-003.
  if (assignee && assignee !== "@github-copilot") {
    await github.addAssignees(argv.repository || "", issueRef.number, [assignee]);
  }

  // Open the issue-ready gate and store issue number for later phases
  const gateId = "issue-ready";
  state = upsertGate(state, { id: gateId, type: "issue", question: `Implementation issue ${issueRef.number} created and assignee set to ${assignee}` });
  state.issue = issueRef.number;
  const labels = new Set(argv.labels ?? []);
  if (labels.has("status:ready") && labels.has("ai:allowed")) {
    state = resolveGate(state, gateId, {
      result: "passed",
      evidence: [issueRef.url],
    });
  }
  await store.save(state);

  const next = computeNextAction(state);
  printResult(
    "issue-create",
    {
      issueNumber: issueRef.number,
      issueUrl: issueRef.url,
      assignee,
      gate: gateId,
    },
    next.detail,
  );
}

async function cmdSpecToIssue(argv: { repository: string; specPath: string }): Promise<void> {
  const result = await runSpecToIssuePipeline({ repository: argv.repository, specPath: argv.specPath });
  const detail =
    result.action === "created"
      ? `Created implementation issue #${result.issue.number} for ${result.specId}.`
      : result.action === "skipped-duplicate"
        ? `Skipped: issue #${result.existingIssue.number} already exists for ${result.specId}.`
        : `Skipped: ${result.reason}`;
  printResult("spec-to-issue", result, detail);
}

/**
 * TAC-08: Reconcile all recoverable human-gate work in a repository. Finds
 * every open `harness:run` tracking issue, then uses the canonical state to
 * select pending gate work or an approved delivery merge whose persisted
 * GitHub effect is still missing.
 * This handles label events that arrived while the trigger workflow was not
 * yet active or had transiently failed (missed-event recovery).
 */
async function cmdReconcile(argv: { repository: string }): Promise<void> {
  // Include resolved gates with durable cleanupPending even if a partial
  // cleanup already removed harness:gate-open.
  const issues = await github.findIssuesWithLabels(argv.repository, [RUN_ISSUE_LABEL]);

  const results: Array<{ issueNumber: number; runId?: string; action?: string; error?: string }> = [];

  for (const issue of issues) {
    try {
      const runState = parseStateFromBody(issue.body);
      const initialNext = computeNextAction(runState);
      if (
        !needsGateReconciliation(runState) &&
        !needsDeliveryMergeReconciliation(runState) &&
        initialNext.action !== "persist-run-documentation"
      ) continue;
      const store = new IssueStateStore(argv.repository, issue.number);
      let state = await retryPendingGatePublication(store, runState);
      state = await retryPendingGateCleanup(store, state);
      const next = computeNextAction(state);

      if (next.action === "persist-run-documentation") {
        results.push({
          issueNumber: issue.number,
          runId: runState.runId,
          action: "persist-run-documentation",
        });
        continue;
      }

      if (next.action === "await-human-gate" && next.gate?.issue) {
        const gateId = next.gate.id;
        const decision = await checkHumanGateIssue(state, gateId);
        if (decision.resolved) {
          // TAC-06: persist first, then cleanup
          const decided = computeGateDecision(state, gateId, decision);
          await store.save(decided);
          state = await postGateDecision(decided, gateId, decision);
          await store.save(state);
          results.push({
            issueNumber: issue.number,
            runId: runState.runId,
            action: `gate '${gateId}' resolved: ${decision.approved ? "approved" : "rejected"}`,
          });
        }
      }

      if (needsDeliveryMergeReconciliation(state)) {
        const deliveryPr = state.deliveryPullRequest ?? state.pullRequest;
        if (deliveryPr === undefined) {
          throw new Error(`run '${state.runId}' has no delivery pull request binding`);
        }
        const prData = await github.viewPullRequest(argv.repository, deliveryPr) as {
          state?: string;
          headRefOid?: string;
          mergedAt?: string | null;
          mergeCommit?: { oid?: string } | null;
        };

        if (prData.state === "MERGED") {
          if (!prData.headRefOid || !prData.mergedAt || !prData.mergeCommit?.oid) {
            throw new Error(`merged delivery PR #${deliveryPr} exposes incomplete merge evidence`);
          }
          state = recordDeliveryMergeEffect(state, {
            pullRequest: deliveryPr,
            approvedHeadSha: prData.headRefOid,
            mergeCommitSha: prData.mergeCommit.oid,
            mergedAt: prData.mergedAt,
          });
          await store.save(state);
          const orchestration = await orchestrate(store);
          results.push({
            issueNumber: issue.number,
            runId: runState.runId,
            action: `delivery PR #${deliveryPr} merge effect persisted; ${orchestration.stopReason}`,
          });
          continue;
        }

        results.push({
          issueNumber: issue.number,
          runId: runState.runId,
          action: `awaiting delivery PR #${deliveryPr} merge`,
        });
        continue;
      }

      results.push({
        issueNumber: issue.number,
        runId: runState.runId,
        action: next.action,
      });
    } catch (err) {
      results.push({ issueNumber: issue.number, error: String(err) });
    }
  }

  printResult(
    "reconcile",
    { reconciled: results },
    `Reconciled ${results.length} open or recoverable gate(s).`,
  );
}

async function cmdIterationStart(argv: StoreArgs): Promise<void> {
  const store = await resolveExistingStore(argv);
  const state = await store.load();
  const { state: nextState, iteration } = startIteration(state);
  await store.save(nextState);
  printResult("iteration-start", { state: nextState, iteration }, `Iteration ${iteration.index} started.`);
}

/**
 * Bind a delivery PR (delivery branch → default branch) to the run.
 * TAC-01/TAC-03.
 */
async function cmdDeliveryPrBind(
  argv: StoreArgs & { pullRequest: number; headSha: string },
): Promise<void> {
  const store = await resolveExistingStore(argv);
  let state = await store.load();
  state = bindDeliveryPullRequest(state, argv.pullRequest, argv.headSha);
  await store.save(state);
  const next = computeNextAction(state);
  printResult("delivery-pr-bind", { state, nextAction: next }, next.detail);
}

/**
 * Bind the Coding Agent's implementation PR to the run.
 * TAC-01/TAC-10: validates that the PR exists and the base is the delivery branch.
 */
async function cmdImplPrBind(
  argv: StoreArgs & { pullRequest: number; headSha: string; expectedBase?: string },
): Promise<void> {
  const store = await resolveExistingStore(argv);
  let state = await store.load();

  // TAC-10: validate base branch if repository is accessible
  if (argv.repository && argv.expectedBase) {
    const prData = await github.viewPullRequest(argv.repository, argv.pullRequest) as {
      baseRefName?: string;
      headRefOid?: string;
    };
    if (prData.baseRefName && prData.baseRefName !== argv.expectedBase) {
      throw new Error(
        `Implementation PR #${argv.pullRequest} has base '${prData.baseRefName}', ` +
        `expected '${argv.expectedBase}'. Refusing to bind a PR with the wrong base branch.`,
      );
    }
  }

  state = bindImplementationPullRequest(state, argv.pullRequest, argv.headSha);
  await store.save(state);
  const next = computeNextAction(state);
  printResult("impl-pr-bind", { state, nextAction: next }, next.detail);
}

async function cmdImplPrAutoBind(argv: { repository: string; pullRequest: number }): Promise<void> {
  const pr = await github.viewPullRequest(argv.repository, argv.pullRequest) as {
    body?: string; headRefOid?: string; baseRefName?: string; url?: string;
  };
  if (!pr.headRefOid || !pr.baseRefName) throw new Error(`PR #${argv.pullRequest} exposes incomplete binding evidence`);
  const body = pr.body ?? "";
  const markerMatch = body.match(/harness:([a-z0-9_-]+)/i);
  let store = markerMatch ? await findRunIssue(argv.repository, markerMatch[1]) : undefined;
  if (!store) {
    const referencedIssues = extractReferencedIssueNumbers(body);
    const matches = (await Promise.all(
      [...new Set(referencedIssues)].map((issue) => findRunIssueByImplementationIssue(argv.repository, issue)),
    )).filter((candidate): candidate is IssueStateStore => candidate !== undefined);
    if (matches.length > 1) throw new Error(`PR #${argv.pullRequest} references multiple harness implementation issues`);
    store = matches[0];
  }
  if (!store) {
    printResult("impl-pr-auto-bind", { bound: false, skipped: "unmanaged-pull-request" }, `No harness run could be resolved for PR #${argv.pullRequest}.`);
    return;
  }
  let state = await store.load();
  if (state.branch && state.branch !== pr.baseRefName) {
    throw new Error(`Implementation PR #${argv.pullRequest} has base '${pr.baseRefName}', expected '${state.branch}'`);
  }
  state = bindImplementationPullRequest(state, argv.pullRequest, pr.headRefOid);
  const marker = `harness:${state.runId}`;
  if (!body.includes(marker)) {
    await github.updatePullRequestBody(argv.repository, argv.pullRequest, `${body.trimEnd()}\n\n<!-- ${marker} -->\n`);
  }
  await store.save(state);
  printResult("impl-pr-auto-bind", { bound: true, runId: state.runId, pullRequest: argv.pullRequest, headSha: pr.headRefOid, marker }, computeNextAction(state).detail);
}

/**
 * Approve the spec on the delivery branch:
 * 1. Validates the spec-approval gate was passed by a human.
 * 2. Reads the bound spec file from the delivery branch.
 * 3. Updates `status: review` → `status: approved` in the frontmatter.
 * 4. Commits the change exclusively on the delivery branch.
 * 5. Binds the new commit SHA as the delivery checkpoint.
 * TAC-02/TAC-03.
 */
async function cmdSpecApprove(
  argv: StoreArgs & { gateId?: string },
): Promise<void> {
  const store = await resolveExistingStore(argv);
  let state = await store.load();
  const gateId = argv.gateId ?? "spec-approval";

  // TAC-02: Validate the human gate is passed
  const gate = findGate(state, gateId);
  if (!gate) {
    throw new Error(`gate '${gateId}' not found on run '${state.runId}'`);
  }
  if (gate.result !== "passed") {
    throw new Error(
      `gate '${gateId}' is not passed (result: '${gate.result}'); spec can only be approved after human approval`,
    );
  }
  if (gate.type !== "spec" && gate.type !== "human") {
    throw new Error(`gate '${gateId}' must be of type 'spec' or 'human', got '${gate.type}'`);
  }

  // TAC-02: Validate paths are explicitly bound
  if (!state.specPath) {
    throw new Error(`specPath is not bound on run '${state.runId}'; bind it at init time via --spec-path`);
  }
  if (!state.branch) {
    throw new Error(`branch is not bound on run '${state.runId}'`);
  }
  if (!argv.repository) {
    throw new Error("--repository is required for spec-approve");
  }

  // TAC-02: Validate remote HEAD matches the bound delivery checkpoint
  const remoteSha = await github.getBranchSha(argv.repository, state.branch);
  const expectedSha = state.deliveryHeadSha ?? state.pullRequestHeadSha;
  if (expectedSha && remoteSha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error(
      `Delivery branch '${state.branch}' remote HEAD (${remoteSha}) ` +
      `does not match bound checkpoint (${expectedSha}). ` +
      `Rebase or update the delivery head before approving.`,
    );
  }

  // Read spec file, patch status, commit
  const { content: specContent, blobSha: specBlobSha } = await github.getFileContent(
    argv.repository, state.specPath, state.branch,
  );
  const approvedSpecContent = specContent.replace(/^(status:\s*)review(\s*)$/m, "$1approved$2");
  if (approvedSpecContent === specContent) {
    // Already approved or status not found — still update the checkpoint
    const newSha = remoteSha;
    state = bindDeliveryPullRequest(state, state.deliveryPullRequest ?? state.pullRequest ?? 0, newSha);
    // If deliveryPullRequest is 0 (fallback for backward compat), just update deliveryHeadSha directly
    if ((state.deliveryPullRequest === 0 || !state.deliveryPullRequest) && state.pullRequest) {
      state = { ...state, deliveryHeadSha: newSha.toLowerCase(), updatedAt: new Date().toISOString() };
    }
  } else {
    // TAC-03: Commit exclusively on the delivery branch
    const newCommitSha = await github.updateFileOnBranch(
      argv.repository,
      state.branch,
      state.specPath,
      approvedSpecContent,
      specBlobSha,
      `docs: approve ${state.spec} status on delivery branch [harness:${state.runId}]`,
    );
    // Also update requirementPath if bound
    let requirementCommitSha = newCommitSha;
    if (state.requirementPath) {
      try {
        const { content: reqContent, blobSha: reqBlobSha } = await github.getFileContent(
          argv.repository, state.requirementPath, state.branch,
        );
        const approvedReqContent = reqContent.replace(/^(status:\s*)review(\s*)$/m, "$1approved$2");
        if (approvedReqContent !== reqContent) {
          requirementCommitSha = await github.updateFileOnBranch(
            argv.repository,
            state.branch,
            state.requirementPath,
            approvedReqContent,
            reqBlobSha,
            `docs: approve ${state.requirement} status on delivery branch [harness:${state.runId}]`,
          );
        }
      } catch {
        // Non-fatal: requirement file may already be approved
      }
    }
    // TAC-03: Bind the new commit SHA as the delivery checkpoint
    const finalSha = requirementCommitSha;
    if (state.deliveryPullRequest) {
      state = bindDeliveryPullRequest(state, state.deliveryPullRequest, finalSha);
    } else if (state.pullRequest) {
      state = bindDeliveryPullRequest(state, state.pullRequest, finalSha);
    } else {
      state = { ...state, deliveryHeadSha: finalSha.toLowerCase(), updatedAt: new Date().toISOString() };
    }
  }

  await store.save(state);
  const next = computeNextAction(state);
  printResult(
    "spec-approve",
    { deliveryHeadSha: state.deliveryHeadSha, specPath: state.specPath, requirementPath: state.requirementPath },
    next.detail,
  );
}

/**
 * Re-read the implementation issue from GitHub and verify body, labels, and
 * assignee. Resolves the `issue-ready` gate as passed or failed based on
 * the actual GitHub state — never on what was written.
 * TAC-06/TAC-07/TAC-08.
 */
async function cmdIssueVerify(
  argv: StoreArgs & {
    expectedLabels?: string[];
    expectedAssignee?: string;
    bodyMarker?: string;
  },
): Promise<void> {
  const store = await resolveExistingStore(argv);
  let state = await store.load();

  if (!state.issue) {
    throw new Error(`no issue number bound on run '${state.runId}'`);
  }
  if (!argv.repository) {
    throw new Error("--repository is required for issue-verify");
  }

  // TAC-06: Re-read from GitHub — never trust the local snapshot
  const issue = await github.viewIssue(argv.repository, state.issue);
  const labelNames = new Set(issue.labels.map((l: { name: string }) => l.name));
  const assigneeLogins = new Set(issue.assignees.map((a: { login: string }) => a.login.toLowerCase()));

  const failures: string[] = [];
  const evidence: string[] = [issue.url];

  // TAC-06/TAC-08: Verify required labels
  const requiredLabels = argv.expectedLabels ?? ["harness:implementation", "status:ready", "ai:allowed"];
  for (const label of requiredLabels) {
    if (!labelNames.has(label)) {
      failures.push(`missing required label '${label}'`);
    }
  }

  // TAC-07: Verify actual assignee (not just a body mention)
  const expectedAssignee = (argv.expectedAssignee ?? "copilot").toLowerCase().replace(/^@/, "");
  if (!assigneeLogins.has(expectedAssignee)) {
    failures.push(
      `assignee '${expectedAssignee}' is not actually set (actual: [${[...assigneeLogins].join(", ")}])`,
    );
  }

  // TAC-06: Verify body is not truncated (check for a key marker or minimum length)
  if (argv.bodyMarker && !issue.body.includes(argv.bodyMarker)) {
    failures.push(`issue body is truncated or missing expected marker: '${argv.bodyMarker}'`);
  }

  const gateId = "issue-ready";
  state = upsertGate(state, { id: gateId, type: "issue", question: `Issue #${state.issue} creation and assignee verified` });

  if (failures.length === 0) {
    // TAC-08: Only report issue-ready: passed after verified GitHub state
    state = resolveGate(state, gateId, { result: "passed", evidence });
  } else {
    state = resolveGate(state, gateId, {
      result: "failed",
      evidence: [...evidence, ...failures],
    });
  }

  await store.save(state);
  const next = computeNextAction(state);
  printResult(
    "issue-verify",
    {
      issueNumber: state.issue,
      labels: [...labelNames],
      assignees: [...assigneeLogins],
      failures,
      gateResult: failures.length === 0 ? "passed" : "failed",
    },
    next.detail,
  );
}

/**
 * Assign the Copilot Coding Agent to the implementation issue.
 * 1. Checks `suggestedActors` to verify Copilot is available.
 * 2. Assigns via the official Agent Assignment API with `baseRef = deliveryBranch`.
 * 3. Re-reads the issue to verify assignment.
 * 4. If not verified, opens a human gate instead of claiming success.
 * TAC-07/TAC-09.
 */
async function cmdAgentAssign(
  argv: StoreArgs & { assignee?: string; baseRef?: string },
): Promise<void> {
  const store = await resolveExistingStore(argv);
  let state = await store.load();

  if (!state.issue) {
    throw new Error(`no issue number bound on run '${state.runId}'`);
  }
  if (!argv.repository) {
    throw new Error("--repository is required for agent-assign");
  }

  const assignee = normalizeAgentLogin(argv.assignee ?? DEFAULT_CODING_AGENT);
  const baseRef = argv.baseRef ?? state.branch;
  if (!baseRef) {
    throw new Error("delivery branch not bound; provide --base-ref or set branch at init time");
  }

  // TAC-09: Check Copilot availability via suggestedActors
  const suggested = await github.checkSuggestedActors(argv.repository, state.issue);
  const available = suggested.length === 0 || suggested.some((a) => normalizeAgentLogin(a) === assignee);

  if (!available) {
    // TAC-09: Open a human gate rather than claiming success
    const gateId = "agent-assign-unavailable";
    state = upsertGate(state, {
      id: gateId,
      type: "human",
      question: `Coding agent '${assignee}' is not in suggestedActors for issue #${state.issue}. ` +
        `Manually assign the agent or confirm its availability, then approve this gate.`,
    });
    if (store.issueRef) {
      state = prepareHumanGateIssue({
        runState: state,
        gateId,
        title: "Coding Agent Not Available",
        question: state.gates.find((g) => g.id === gateId)?.question ?? "",
        context: [`Repository: ${argv.repository}`, `Issue: #${state.issue}`, `Expected assignee: ${assignee}`],
        runIssue: store.issueRef,
      });
      state = await publishHumanGateIssue(state, gateId, (checkpoint) => store.save(checkpoint));
    }
    await store.save(state);
    const next = computeNextAction(state);
    printResult("agent-assign", { available: false, assignee }, next.detail);
    return;
  }

  const issueBeforeAssignment = await github.viewIssue(argv.repository, state.issue);
  const marker = `harness:${state.runId}`;
  if (!issueBeforeAssignment.body.includes(marker)) {
    await github.updateIssueBody(
      argv.repository,
      state.issue,
      `${issueBeforeAssignment.body.trimEnd()}\n\n<!-- ${marker} -->\n`,
    );
  }

  // TAC-07: Assign via the official Agent Assignment API
  await github.assignCodingAgent(argv.repository, state.issue, assignee, baseRef);

  // TAC-07: bounded retry for GitHub's eventually-consistent assignee view.
  const verification = await pollForAgentAssignment(
    () => github.viewIssue(argv.repository!, state.issue!),
    assignee,
  );
  const issue = verification.issue;
  const assigneeLogins = issue.assignees.map((a: { login: string }) => a.login.toLowerCase());
  const assigned = verification.assigned;

  if (!assigned) {
    const gateId = "agent-assign-unverified";
    state = upsertGate(state, {
      id: gateId,
      type: "human",
      question: `Attempted to assign '${assignee}' to issue #${state.issue} but the assignment ` +
        `was not reflected in the re-read issue state (actual assignees: [${assigneeLogins.join(", ")}]). ` +
        `Manually verify and assign, then approve this gate.`,
    });
    if (store.issueRef) {
      state = prepareHumanGateIssue({
        runState: state,
        gateId,
        title: "Coding Agent Assignment Unverified",
        question: state.gates.find((g) => g.id === gateId)?.question ?? "",
        context: [`Issue URL: ${issue.url}`, `Actual assignees: [${assigneeLogins.join(", ")}]`],
        runIssue: store.issueRef,
      });
      state = await publishHumanGateIssue(state, gateId, (checkpoint) => store.save(checkpoint));
    }
    await store.save(state);
    const next = computeNextAction(state);
    printResult("agent-assign", { available: true, assigned: false, assignee }, next.detail);
    return;
  }

  const reconciled = recordVerifiedAgentAssignment(state, {
    assignee, baseRef, issueUrl: issue.url, verifiedAt: new Date().toISOString(),
  });
  state = reconciled.state;
  for (const gateId of reconciled.supersededGateIds) {
    if (store.issueRef) {
      await github.commentIssue(
        store.issueRef.repository,
        store.issueRef.number,
        `Harness: Gate \`${gateId}\` wurde ohne menschliche Entscheidung als False Positive superseded, nachdem GitHub die Zuweisung an \`${assignee}\` verifiziert hat.`,
      );
    }
  }
  if (store.issueRef && !state.gates.some((gate) => gate.type === "human" && (gate.result === "pending" || gate.result === "needs-human"))) {
    await github.removeLabels(store.issueRef.repository, store.issueRef.number, ["status:needs-human", "harness:gate-open"]);
  }
  await store.save(state);
  const next = computeNextAction(state);
  printResult(
    "agent-assign",
    { available: true, assigned: true, assignee, baseRef, issueNumber: state.issue, verificationAttempts: verification.attempts },
    next.detail,
  );
}

/**
 * Merge the implementation PR into the delivery branch after gate checks.
 * Blocks if CI is not green or reviews are unresolved.
 * After a successful merge, rebinds the delivery head and invalidates evidence.
 * TAC-11.
 */
async function cmdImplPrMerge(argv: StoreArgs): Promise<void> {
  const store = await resolveExistingStore(argv);
  let state = await store.load();

  const implPr = state.implementationPullRequest;
  if (!implPr) {
    throw new Error(`no implementation PR bound on run '${state.runId}'`);
  }
  if (!argv.repository) {
    throw new Error("--repository is required for impl-pr-merge");
  }

  // TAC-11: Check CI and review gates
  const prData = await github.viewPullRequest(argv.repository, implPr) as {
    mergeStateStatus?: string;
    reviewDecision?: string;
    statusCheckRollup?: Array<{ state: string }> | null;
    headRefOid?: string;
    baseRefName?: string;
  };

  const gateId = "impl-pr-ready";
  const failures: string[] = [];
  const evidence: string[] = [`https://github.com/${argv.repository}/pull/${implPr}`];

  if (prData.reviewDecision && prData.reviewDecision !== "APPROVED" && prData.reviewDecision !== "") {
    failures.push(`review not approved (reviewDecision: '${prData.reviewDecision}')`);
  }
  if (prData.mergeStateStatus && !["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(prData.mergeStateStatus)) {
    failures.push(`PR not ready to merge (mergeStateStatus: '${prData.mergeStateStatus}')`);
  }
  const checks = prData.statusCheckRollup ?? [];
  const failedChecks = checks.filter((c) => c.state === "FAILURE" || c.state === "ERROR");
  if (failedChecks.length > 0) {
    failures.push(`${failedChecks.length} CI check(s) failed`);
  }

  // Upsert gate (idempotent) and reflect current CI/review state
  state = upsertGate(state, { id: gateId, type: "runtime", question: `Implementation PR #${implPr} CI and review checks` });

  if (failures.length > 0) {
    state = resolveGate(state, gateId, { result: "failed", evidence: [...evidence, ...failures] });
    await store.save(state);
    const next = computeNextAction(state);
    printResult("impl-pr-merge", { merged: false, failures }, next.detail);
    return;
  }

  state = resolveGate(state, gateId, { result: "passed", evidence });

  // TAC-11: Merge the PR
  const mergeSha = await github.mergePullRequest(argv.repository, implPr);

  // TAC-11: Rebind delivery head with the post-merge SHA and invalidate evidence
  if (state.deliveryPullRequest) {
    state = bindDeliveryPullRequest(state, state.deliveryPullRequest, mergeSha);
  } else if (state.pullRequest) {
    state = bindDeliveryPullRequest(state, state.pullRequest, mergeSha);
  } else {
    state = { ...state, deliveryHeadSha: mergeSha.toLowerCase(), updatedAt: new Date().toISOString() };
  }

  await store.save(state);
  const next = computeNextAction(state);
  printResult(
    "impl-pr-merge",
    { merged: true, mergeSha, deliveryHeadSha: state.deliveryHeadSha, implPr },
    next.detail,
  );
}

/**
 * Persist the GitHub-verified merge effect of the bound delivery PR.
 * A passed merge-approval gate authorises the SHA, but the run may complete
 * only after GitHub reports the PR as merged and exposes the resulting merge commit.
 */
async function cmdDeliveryPrMergeEffect(
  argv: StoreArgs & { pullRequest?: number },
): Promise<void> {
  const store = await resolveExistingStore(argv);
  let state = await store.load();

  const classification = classifyDeliveryPrMergeEffect(state, argv.pullRequest);
  if (classification.kind === "unbound") {
    if (argv.pullRequest !== undefined) {
      throw new Error(`no delivery PR bound on run '${state.runId}'`);
    }
    const next = computeNextAction(state);
    printResult(
      "delivery-pr-merge-effect",
      { skipped: "no-delivery-pr-bound", nextAction: next },
      next.detail,
    );
    return;
  }
  if (classification.kind === "skip") {
    const next = computeNextAction(state);
    printResult(
      "delivery-pr-merge-effect",
      {
        deliveryPullRequest: classification.deliveryPullRequest,
        observedPullRequest: classification.observedPullRequest,
        skipped: "non-delivery-pull-request",
        nextAction: next,
      },
      next.detail,
    );
    return;
  }

  if (!argv.repository) {
    throw new Error("--repository is required for delivery-pr-merge-effect");
  }

  const deliveryPr = classification.deliveryPullRequest;

  const prData = await github.viewPullRequest(argv.repository, deliveryPr) as {
    state?: string;
    headRefOid?: string;
    mergedAt?: string | null;
    mergeCommit?: { oid?: string } | null;
  };

  if (prData.state !== "MERGED") {
    const next = computeNextAction(state);
    printResult(
      "delivery-pr-merge-effect",
      {
        deliveryPullRequest: deliveryPr,
        pending: "delivery-pr-not-yet-merged",
        prState: prData.state ?? "unknown",
        nextAction: next,
      },
      next.detail,
    );
    return;
  }
  if (!prData.headRefOid) {
    throw new Error(`delivery PR #${deliveryPr} did not expose a HEAD SHA`);
  }
  if (!prData.mergedAt) {
    throw new Error(`delivery PR #${deliveryPr} did not expose a mergedAt timestamp`);
  }
  if (!prData.mergeCommit?.oid) {
    throw new Error(`delivery PR #${deliveryPr} did not expose a merge commit SHA`);
  }

  if (!findPassedMergeApprovalGate(state)) {
    const next = computeNextAction(state);
    printResult(
      "delivery-pr-merge-effect",
      {
        deliveryPullRequest: deliveryPr,
        pending: "no-passed-merge-approval-gate",
        nextAction: next,
      },
      next.detail,
    );
    return;
  }

  state = recordDeliveryMergeEffect(state, {
    pullRequest: deliveryPr,
    approvedHeadSha: prData.headRefOid,
    mergeCommitSha: prData.mergeCommit.oid,
    mergedAt: prData.mergedAt,
  });

  await store.save(state);
  const next = computeNextAction(state);
  printResult(
    "delivery-pr-merge-effect",
    {
      deliveryPullRequest: deliveryPr,
      approvedHeadSha: prData.headRefOid,
      deliveryMergeCommitSha: state.deliveryMergeCommitSha,
      deliveryMergedAt: state.deliveryMergedAt,
      nextAction: next,
    },
    next.detail,
  );
}

/**
 * Run the bounded, idempotent orchestrator:
 * advances gate-free phases up to --max-steps times and stops at any gate,
 * error, or completion. Outputs the full step log and stop reason.
 * TAC-04.
 */
async function cmdOrchestrate(argv: StoreArgs & { maxSteps?: number; stopAtPhase?: PhaseId }): Promise<void> {
  const store = await resolveExistingStore(argv);
  const result = await orchestrate(store, argv.maxSteps, argv.stopAtPhase);
  printResult(
    "orchestrate",
    result,
    result.finalNextAction.detail,
  );
}

async function cmdReviewFix(argv: {
  repository: string;
  pullRequest: number;
  reviewId: number;
  headSha: string;
  reviewer: string;
  reviewerType: string;
  reviewState: string;
  submittedAt: string;
  trustedActors: string;
  fixAgent: string;
  selfActorLogin: string;
}): Promise<void> {
  const store = await findRunIssueByPullRequest(argv.repository, argv.pullRequest);
  if (!store) {
    printResult(
      "review-fix",
      { hasActionable: false, gateOpened: false, classifiedKeys: [], dispatched: false, skipped: "unmanaged-pull-request" },
      `No open harness run is bound to PR #${argv.pullRequest}; nothing to remediate.`,
    );
    return;
  }
  const state = await store.load();
  const preExistingHumanGate = state.gates.some(
    (gate) => gate.type === "human" && (gate.result === "pending" || gate.result === "needs-human"),
  );
  if (preExistingHumanGate) {
    printResult(
      "review-fix",
      { hasActionable: false, gateOpened: false, classifiedKeys: [], dispatched: false, deferred: "open-human-gate" },
      "Remediation is deferred by an open human gate; review and thread idempotency remain unconsumed for retry.",
    );
    return;
  }
  const threads = await github.listPullRequestReviewThreads(argv.repository, argv.pullRequest);
  const result = processReviewEvent(
    state,
    {
      reviewerLogin: argv.reviewer,
      reviewerType: argv.reviewerType,
      reviewId: argv.reviewId,
      reviewState: argv.reviewState,
      submittedAt: argv.submittedAt,
      reviewedHeadSha: argv.headSha,
      pullRequest: argv.pullRequest,
      repository: argv.repository,
    },
    threads.map((thread) => {
      const comment = thread.comments[0];
      return {
        threadId: thread.id,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        authorLogin: comment?.author?.login ?? "unknown",
        authorType: comment?.author?.__typename ?? "Unknown",
        body: comment?.body ?? "",
        reviewId: comment?.reviewId ? comment.reviewId : argv.reviewId,
      };
    }),
    {
      selfActorLogin: argv.selfActorLogin,
      trustedActors: argv.trustedActors.split(",").map((actor) => actor.trim()).filter(Boolean),
    },
  );
  await store.save(result.state);
  let dispatched = false;
  const hasOpenHumanGate = result.state.gates.some(
    (gate) => gate.type === "human" && (gate.result === "pending" || gate.result === "needs-human"),
  );
  if (result.hasActionable && !result.gateOpened && !hasOpenHumanGate) {
    const agentMention = argv.fixAgent === "github-copilot"
      ? "@copilot"
      : argv.fixAgent === "claude-code"
        ? "@claude"
        : undefined;
    if (!agentMention) {
      throw new Error(`unsupported HARNESS_REVIEW_FIX_AGENT '${argv.fixAgent}'`);
    }
    await github.commentIssue(
      argv.repository,
      argv.pullRequest,
      `${agentMention} Please address all unresolved actionable review threads for this PR on the existing PR branch. ` +
        `Do not create another pull request or expand scope. Run the relevant checks, push the fixes to this branch, ` +
        `then reply to each implemented thread with commit and test evidence. Review package: ${result.classifiedKeys.join(", ")}`,
    );
    dispatched = true;
  }
  printResult(
    "review-fix",
    {
      hasActionable: result.hasActionable,
      gateOpened: result.gateOpened,
      classifiedKeys: result.classifiedKeys,
      dispatched,
    },
    dispatched
      ? "Dispatched the configured review-fix agent for the classified package."
      : hasOpenHumanGate || result.gateOpened
        ? "Remediation is blocked by an open human gate."
        : "No remediation required.",
  );
}

async function cmdIterationFinish(
  argv: StoreArgs & { index: number; result: "passed" | "failed"; findings?: string[] },
): Promise<void> {
  const store = await resolveExistingStore(argv);
  let state = await store.load();
  state = finishIteration(state, argv.index, argv.result, argv.findings);
  await store.save(state);
  const next = computeNextAction(state);
  printResult("iteration-finish", { state, nextAction: next }, next.detail);
}

const _harnessCli = yargs(hideBin(process.argv))
  .scriptName("harness")
  .command(
    "pr-bind",
    "Bind exactly one pull request and immutable head SHA to the run",
    (y) =>
      storeOptions(y)
        .option("pull-request", { type: "number", demandOption: true })
        .option("head-sha", { type: "string", demandOption: true }),
    async (argv) =>
      cmdPrBind({
        state: argv.state,
        repository: argv.repository,
        runId: argv.runId,
        pullRequest: argv.pullRequest,
        headSha: argv.headSha,
      }),
  )
  .command(
    "init",
    "Initialize (or idempotently reconcile) a run. Uses the file backend if --state is given, otherwise the GitHub-issue backend (--repository + --run-id create/find the tracking issue).",
    (y) =>
      storeOptions(y)
        .option("run-id", { type: "string", demandOption: true })
        .option("repository", { type: "string", demandOption: true })
        .option("requirement", { type: "string", demandOption: true })
        .option("spec", { type: "string", demandOption: true })
        .option("issue", { type: "number" })
        .option("branch", { type: "string" })
        .option("max-automatic-iterations", { type: "number" })
        .option("requirement-path", { type: "string", describe: "Explicit path to the requirement document (repo-relative)" })
        .option("spec-path", { type: "string", describe: "Explicit path to the spec document (repo-relative)" })
        .option("delivery-pull-request", { type: "number", describe: "Delivery PR number if already known" })
        .option("delivery-head-sha", { type: "string", describe: "Delivery PR HEAD SHA if already known" })
        .option("install-bug-workflow", {
          type: "boolean",
          default: false,
          describe: "Install/update managed bug-triage workflow reference in the target repository",
        })
        .option("bug-workflow-ref", {
          type: "string",
          describe: "Pinned ref for munichdeveloper/pi-spec-harness reusable bug workflow (tag or SHA)",
        })
        .option("bug-workflow-repository", {
          type: "string",
          default: "munichdeveloper/pi-spec-harness",
          describe: "Repository that hosts the reusable bug-triage workflow",
        })
        .option("bug-workflow-path", {
          type: "string",
          default: ".github/workflows/harness-bug-triage.yml",
          describe: "Path of the thin bug-triage reference workflow in the target repository",
        })
        .option("bug-workflow-reviewer", {
          type: "string",
          describe: "Optional fixed reviewer/assignee login for PRs created by the bug pipeline",
        })
        .option("bug-workflow-claude-version", {
          type: "string",
          describe: "Pinned claude-code-action version to embed in the reference workflow",
        })
        .option("bug-workflow-preview-command", {
          type: "string",
          describe: "Optional preview verification command embedded in the reference workflow",
        })
        .option("install-workflows", {
          type: "string",
          describe: "Comma-separated list of WORKFLOW_TEMPLATE_CATALOG names to install/update (e.g. bug-triage,spec-to-issue,label-approval-bundling)",
        })
        .option("workflow-ref", {
          type: "string",
          describe: "Pinned ref (tag or SHA) for reusable workflows installed via --install-workflows (defaults to each template's own default ref)",
        })
        .option("workflow-repository", {
          type: "string",
          describe: "Repository that hosts the reusable workflows installed via --install-workflows",
        })
        .option("spec-path-glob", {
          type: "string",
          describe: "Path glob that triggers the installed spec-to-issue reference workflow",
        })
        .option("spec-to-issue-default-branch", {
          type: "string",
          describe: "Default branch that triggers the installed spec-to-issue reference workflow",
        })
        .option("trigger-label", {
          type: "string",
          describe: "Freigabe-Label that triggers the installed label-approval-bundling reference workflow",
        })
        .option("target-labels", {
          type: "array",
          string: true,
          describe: "Labels bundled by the installed label-approval-bundling reference workflow",
        })
        .option("install-agents-context", {
          type: "boolean",
          default: false,
          describe: "Install/update the managed pi-spec-harness context block in the target repository's AGENTS.md",
        }),
    async (argv) =>
      cmdInit({
        runId: argv.runId,
        repository: argv.repository,
        requirement: argv.requirement,
        spec: argv.spec,
        issue: argv.issue,
        branch: argv.branch,
        state: argv.state,
        maxAutomaticIterations: argv.maxAutomaticIterations,
        requirementPath: argv["requirement-path"] as string | undefined,
        specPath: argv["spec-path"] as string | undefined,
        deliveryPullRequest: argv["delivery-pull-request"] as number | undefined,
        deliveryHeadSha: argv["delivery-head-sha"] as string | undefined,
        installBugWorkflow: argv["install-bug-workflow"] as boolean | undefined,
        bugWorkflowRef: argv["bug-workflow-ref"] as string | undefined,
        bugWorkflowRepository: argv["bug-workflow-repository"] as string | undefined,
        bugWorkflowPath: argv["bug-workflow-path"] as string | undefined,
        bugWorkflowReviewer: argv["bug-workflow-reviewer"] as string | undefined,
        bugWorkflowClaudeVersion: argv["bug-workflow-claude-version"] as string | undefined,
        bugWorkflowPreviewCommand: argv["bug-workflow-preview-command"] as string | undefined,
        installWorkflows: argv["install-workflows"] as string | undefined,
        workflowRef: argv["workflow-ref"] as string | undefined,
        workflowRepository: argv["workflow-repository"] as string | undefined,
        specPathGlob: argv["spec-path-glob"] as string | undefined,
        specToIssueDefaultBranch: argv["spec-to-issue-default-branch"] as string | undefined,
        triggerLabel: argv["trigger-label"] as string | undefined,
        targetLabels: argv["target-labels"] as string[] | undefined,
        installAgentsContext: argv["install-agents-context"] as boolean | undefined,
      }),
  )
  .command(
    "status",
    "Show current run status and next action",
    (y) => storeOptions(y),
    async (argv) => cmdStatus(argv),
  )
  .command(
    "resume",
    "Recompute next action; poll any open human-gate issue for a decision",
    (y) => storeOptions(y),
    async (argv) => cmdResume(argv),
  )
  .command(
    "advance",
    "Advance exactly one phase when all current gates are resolved",
    (y) => storeOptions(y),
    async (argv) => cmdAdvance(argv),
  )
  .command(
    "gate-open",
    "Register a gate; for type=human this reuses the run's tracking issue",
    (y) =>
      storeOptions(y)
        .option("gate-id", { type: "string", demandOption: true })
        .option("type", { type: "string", demandOption: true, choices: ["spec", "issue", "runtime", "review", "human", "merge"] as const })
        .option("title", { type: "string", default: "" })
        .option("question", { type: "string", default: "" })
        .option("context", { type: "array", string: true })
        .option("scope", { type: "string" })
        .option("criterion", { type: "array", string: true })
        .option("risk", { type: "array", string: true })
        .option("non-goal", { type: "array", string: true })
        .option("follow-up-action", { type: "string" }),
    async (argv) =>
      cmdGateOpen({
        state: argv.state,
        repository: argv.repository,
        runId: argv.runId,
        gateId: argv.gateId,
        type: argv.type as GateType,
        title: argv.title,
        question: argv.question,
        context: argv.context as string[] | undefined,
        scope: argv.scope,
        criterion: argv.criterion as string[] | undefined,
        risk: argv.risk as string[] | undefined,
        nonGoal: argv.nonGoal as string[] | undefined,
        followUpAction: argv.followUpAction,
      }),
  )
  .command(
    "gate-resolve",
    "Manually resolve a non-human gate (spec/issue/runtime/review/merge)",
    (y) =>
      storeOptions(y)
        .option("gate-id", { type: "string", demandOption: true })
        .option("result", { type: "string", demandOption: true, choices: ["passed", "failed"] as const })
        .option("evidence", { type: "array", string: true }),
    async (argv) =>
      cmdGateResolve({
        state: argv.state,
        repository: argv.repository,
        runId: argv.runId,
        gateId: argv.gateId,
        result: argv.result as "passed" | "failed",
        evidence: argv.evidence as string[] | undefined,
      }),
  )
  .command(
    "phase",
    "Force-set the current phase (use sparingly; prefer computeNextAction-driven advancement)",
    (y) =>
      storeOptions(y).option("phase", {
        type: "string",
        demandOption: true,
        choices: [
          "requirement",
          "spec",
          "issue",
          "implementation",
          "verification",
          "iteration",
          "documentation",
          "merge",
          "complete",
        ] as const,
      }),
    async (argv) => cmdPhase({ state: argv.state, repository: argv.repository, runId: argv.runId, phase: argv.phase as PhaseId }),
  )
  .command(
    "gate-acknowledge",
    "Acknowledge a rejected human gate (records how the run proceeds after rejection)",
    (y) =>
      storeOptions(y)
        .option("gate-id", { type: "string", demandOption: true })
        .option("note", { type: "string", demandOption: true }),
    async (argv) =>
      cmdGateAcknowledge({ state: argv.state, repository: argv.repository, runId: argv.runId, gateId: argv.gateId, note: argv.note }),
  )
  .command(
    "note",
    "Append a free-form, hygiene-checked note to the run",
    (y) => storeOptions(y).option("text", { type: "string", demandOption: true }),
    async (argv) => cmdNote({ state: argv.state, repository: argv.repository, runId: argv.runId, text: argv.text }),
  )
  .command(
    "issue-create",
    "Create an implementation issue and assign based on spec's implementation_assignee field",
    (y) =>
      storeOptions(y)
        .option("title", { type: "string", describe: "Issue title (omit when --from-spec-path is given)" })
        .option("body", { type: "string", describe: "Issue body (Markdown)" })
        .option("body-file", { type: "string", describe: "Path to file with issue body (markdown)" })
        .option("from-spec-path", { type: "string", describe: "Path to an approved spec file; derives title/body via buildIssueFromSpec() instead of --title/--body (SPEC-007)" })
        .option("labels", { type: "array", string: true, describe: "Labels to apply" })
        .option("assignee", { type: "string", describe: "Override assignee (defaults to spec's implementation_assignee or @github-copilot)" })
        .check((argv) => {
          if (argv["from-spec-path"]) return true;
          if (!argv.title) {
            throw new Error("--title is required unless --from-spec-path is given");
          }
          if (!argv.body && !argv["body-file"]) {
            throw new Error("Either --body or --body-file is required");
          }
          return true;
        }),
    async (argv) =>
      cmdIssueCreate({
        state: argv.state,
        repository: argv.repository,
        runId: argv.runId,
        title: argv.title as string | undefined,
        body: argv.body as string | undefined,
        bodyFile: argv["body-file"] as string | undefined,
        fromSpecPath: argv["from-spec-path"] as string | undefined,
        labels: argv.labels as string[] | undefined,
        assignee: argv.assignee as string | undefined,
      }),
  )
  .command(
    "spec-to-issue",
    "Reactive entrypoint (no run/tracking-issue required): create an implementation issue for an approved spec, unless one already exists (SPEC-007)",
    (y) =>
      y
        .option("repository", { type: "string", demandOption: true, describe: "owner/repo" })
        .option("spec-path", { type: "string", demandOption: true, describe: "Path to the spec file to evaluate" }),
    async (argv) =>
      cmdSpecToIssue({
        repository: argv.repository,
        specPath: argv["spec-path"] as string,
      }),
  )
  .command(
    "iteration-start",
    "Start a new automatic correction iteration",
    (y) => storeOptions(y),
    async (argv) => cmdIterationStart(argv),
  )
  .command(
    "iteration-finish",
    "Finish the current iteration",
    (y) =>
      storeOptions(y)
        .option("index", { type: "number", demandOption: true })
        .option("result", { type: "string", demandOption: true, choices: ["passed", "failed"] as const })
        .option("findings", { type: "array", string: true }),
    async (argv) =>
      cmdIterationFinish({
        state: argv.state,
        repository: argv.repository,
        runId: argv.runId,
        index: argv.index,
        result: argv.result as "passed" | "failed",
        findings: argv.findings as string[] | undefined,
      }),
  )
  .command(
    "delivery-pr-bind",
    "Bind the delivery PR (against default branch) and its HEAD SHA to the run",
    (y) =>
      storeOptions(y)
        .option("pull-request", { type: "number", demandOption: true })
        .option("head-sha", { type: "string", demandOption: true }),
    async (argv) =>
      cmdDeliveryPrBind({
        state: argv.state,
        repository: argv.repository,
        runId: argv.runId,
        pullRequest: argv.pullRequest,
        headSha: argv.headSha,
      }),
  )
  .command(
    "impl-pr-bind",
    "Bind the implementation PR (Coding Agent, against delivery branch) to the run",
    (y) =>
      storeOptions(y)
        .option("pull-request", { type: "number", demandOption: true })
        .option("head-sha", { type: "string", demandOption: true })
        .option("expected-base", { type: "string", describe: "Expected base branch (validated against GitHub)" }),
    async (argv) =>
      cmdImplPrBind({
        state: argv.state,
        repository: argv.repository,
        runId: argv.runId,
        pullRequest: argv.pullRequest,
        headSha: argv.headSha,
        expectedBase: argv["expected-base"] as string | undefined,
      }),
  )
  .command(
    "impl-pr-auto-bind",
    "Resolve an agent PR from its linked implementation issue, bind it, and persist the harness marker",
    (y) => y.option("repository", { type: "string", demandOption: true }).option("pull-request", { type: "number", demandOption: true }),
    async (argv) => cmdImplPrAutoBind({ repository: argv.repository, pullRequest: argv.pullRequest }),
  )
  .command(
    "spec-approve",
    "Commit spec-approval status on the delivery branch and bind the new delivery checkpoint",
    (y) =>
      storeOptions(y)
        .option("gate-id", { type: "string", default: "spec-approval", describe: "The gate id of the spec-approval gate" }),
    async (argv) =>
      cmdSpecApprove({
        state: argv.state,
        repository: argv.repository,
        runId: argv.runId,
        gateId: argv.gateId,
      }),
  )
  .command(
    "issue-verify",
    "Re-read the implementation issue from GitHub and verify body, labels, and assignee",
    (y) =>
      storeOptions(y)
        .option("expected-labels", { type: "array", string: true, describe: "Labels that must be present" })
        .option("expected-assignee", { type: "string", describe: "Assignee login that must be set (default: copilot)" })
        .option("body-marker", { type: "string", describe: "String that must be present in the issue body" }),
    async (argv) =>
      cmdIssueVerify({
        state: argv.state,
        repository: argv.repository,
        runId: argv.runId,
        expectedLabels: argv["expected-labels"] as string[] | undefined,
        expectedAssignee: argv["expected-assignee"] as string | undefined,
        bodyMarker: argv["body-marker"] as string | undefined,
      }),
  )
  .command(
    "agent-assign",
    "Assign the Copilot Coding Agent to the implementation issue via the official API",
    (y) =>
      storeOptions(y)
        .option("assignee", { type: "string", describe: "Agent login to assign (default: copilot)" })
        .option("base-ref", { type: "string", describe: "Delivery branch to set as baseRef (default: state.branch)" }),
    async (argv) =>
      cmdAgentAssign({
        state: argv.state,
        repository: argv.repository,
        runId: argv.runId,
        assignee: argv.assignee as string | undefined,
        baseRef: argv["base-ref"] as string | undefined,
      }),
  )
  .command(
    "impl-pr-merge",
    "Merge the implementation PR into the delivery branch after CI and review gates pass",
    (y) => storeOptions(y),
    async (argv) =>
      cmdImplPrMerge({
        state: argv.state,
        repository: argv.repository,
        runId: argv.runId,
      }),
  )
  .command(
    "delivery-pr-merge-effect",
    "Persist the GitHub-verified merge effect for the bound delivery PR before completing the run",
    (y) =>
      storeOptions(y)
        .option("pull-request", { type: "number", describe: "Delivery pull request number (defaults to the bound delivery PR)" }),
    async (argv) =>
      cmdDeliveryPrMergeEffect({
        state: argv.state,
        repository: argv.repository,
        runId: argv.runId,
        pullRequest: argv.pullRequest,
      }),
  )
  .command(
    "persist-run-documentation",
    "Persist the run documentation snapshot to the repository and record the checkpoint in run state (SPEC-012)",
    (y) =>
      y
        .option("repository", { type: "string", demandOption: true, describe: "owner/repo of the target repository" })
        .option("issue-number", { type: "number", demandOption: true, describe: "Tracking issue number (harness:run issue)" })
        .option("generated-directory", { type: "string", describe: "Directory for generated snapshots (default: docs/runs/generated)" })
        .option("legacy-directory", { type: "array", string: true, describe: "Legacy directory/directories to scan for existing run documents (may be specified multiple times; default: docs/runs)" })
        .option("index-path", { type: "string", describe: "Path for the run index document (default: docs/runs/RUN-INDEX.md)" })
        .option("obsidian-base-path", { type: "string", describe: "Path for the Obsidian base document (default: docs/runs/Runs.base)" })
        .option("branch", { type: "string", describe: "Default branch to write to (default: main)" })
        .option("harness-version", { type: "string", describe: "Harness version string to embed in the snapshot metadata" })
        .option("audit-recorder-repo", { type: "string", describe: "owner/repo of the REQ-005 audit recorder (default: same as --repository)" })
        .option("audit-journal-path", { type: "string", describe: "Path to the audit journal directory in the recorder repo (default: docs/process-audit/journal)" })
        .option("audit-access-role", { type: "string", describe: "Access role of the credential used for audit dispatch (e.g. GITHUB_PERSONAL_ACCESS_TOKEN); required when audit-recorder-repo is a different repository" })
        .option("audit-receiver-ref", { type: "string", describe: "Exact immutable harness ref that the installed process-audit receiver workflow must reference (e.g. a commit SHA or semver tag)" }),

    async (argv) =>
      cmdPersistRunDocumentation({
        repository: argv.repository as string,
        issueNumber: argv["issue-number"] as number,
        generatedDirectory: argv["generated-directory"] as string | undefined,
        legacyDirectories: argv["legacy-directory"] as string[] | undefined,
        indexPath: argv["index-path"] as string | undefined,
        obsidianBasePath: argv["obsidian-base-path"] as string | undefined,
        branch: argv.branch as string | undefined,
        harnessVersion: argv["harness-version"] as string | undefined,
        auditRecorderRepo: argv["audit-recorder-repo"] as string | undefined,
        auditJournalPath: argv["audit-journal-path"] as string | undefined,
        auditAccessRole: argv["audit-access-role"] as string | undefined,
        auditReceiverRef: argv["audit-receiver-ref"] as string | undefined,
      }),
  )
  .command(
    "review-fix",
    "Persist and classify a submitted review for the exactly bound PR and SHA",
    (y) =>
      y
        .option("repository", { type: "string", demandOption: true })
        .option("pull-request", { type: "number", demandOption: true })
        .option("review-id", { type: "number", demandOption: true })
        .option("head-sha", { type: "string", demandOption: true })
        .option("reviewer", { type: "string", demandOption: true })
        .option("reviewer-type", { type: "string", demandOption: true })
        .option("review-state", { type: "string", demandOption: true })
        .option("submitted-at", { type: "string", demandOption: true })
        .option("trusted-actors", { type: "string", demandOption: true })
        .option("fix-agent", { type: "string", demandOption: true })
        .option("self-actor-login", { type: "string", demandOption: true }),
    async (argv) =>
      cmdReviewFix({
        repository: argv.repository,
        pullRequest: argv.pullRequest,
        reviewId: argv.reviewId,
        headSha: argv.headSha,
        reviewer: argv.reviewer,
        reviewerType: argv.reviewerType,
        reviewState: argv.reviewState,
        submittedAt: argv.submittedAt,
        trustedActors: argv.trustedActors,
        fixAgent: argv.fixAgent,
        selfActorLogin: argv.selfActorLogin,
      }),
  )
  .command(
    "orchestrate",
    "Run the bounded, idempotent orchestrator (advance gate-free phases until a gate, error, or completion)",
    (y) =>
      storeOptions(y)
        .option("max-steps", { type: "number", default: 10, describe: "Maximum number of phase-advance steps" })
        .option("stop-at-phase", { type: "string", choices: PHASE_ORDER, describe: "Stop successfully once this phase is reached" }),
    async (argv) =>
      cmdOrchestrate({
        state: argv.state,
        repository: argv.repository,
        runId: argv.runId,
        maxSteps: argv.maxSteps,
        stopAtPhase: argv["stop-at-phase"] as PhaseId | undefined,
      }),
  )
  .command(
    "reconcile",
    "Find all open harness gates in a repository and apply any pending label decisions (missed-event recovery)",
    (y) => y.option("repository", { type: "string", demandOption: true, describe: "owner/repo to reconcile" }),
    async (argv) => cmdReconcile({ repository: argv.repository as string }),
  )
  .demandCommand(1)
  .strict();

// Guard: only execute the CLI when this module is the entry point, not when
// imported by tests or other modules. `VITEST` is set to "true" by vitest.
if (!process.env["VITEST"]) {
  await _harnessCli.parse();
}
