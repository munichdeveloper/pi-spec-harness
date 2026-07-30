#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import yargs, { type Argv } from "yargs";
import { hideBin } from "yargs/helpers";
import {
  acknowledgeRejectedHumanGate,
  checkHumanGateIssue,
  computeGateDecision,
  openHumanGateIssue,
  postGateDecision,
} from "./gates/human-gate.js";
import { GATE_LABEL } from "./gates/human-gate.js";
import { github } from "./github/gh.js";
import { getSpecAssignee } from "./spec/spec-parser.js";
import { IssueStateStore, RUN_ISSUE_LABEL, ensureRunIssue, findRunIssue, parseStateFromBody } from "./state/issue-store.js";
import type { StateStore } from "./state/state-store.js";
import { FileStateStore } from "./state/store.js";
import {
  PHASE_ORDER,
  computeNextAction,
  bindPullRequest,
  findGate,
  finishIteration,
  initRunState,
  reconcileInit,
  resolveGate,
  startIteration,
  transitionPhase,
  upsertGate,
} from "./state/state-machine.js";
import type { GateType, PhaseId, RunState } from "./state/types.js";
import { SCHEMA_VERSION } from "./state/types.js";

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

async function cmdInit(argv: {
  runId: string;
  repository: string;
  requirement: string;
  spec: string;
  issue?: number;
  branch?: string;
  state?: string;
  maxAutomaticIterations?: number;
}): Promise<void> {
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

  printResult(
    "init",
    { location: argv.state ?? store.issueRef?.url, state },
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
  const next = computeNextAction(state);

  if (next.action === "await-human-gate" && next.gate?.issue) {
    const decision = await checkHumanGateIssue(state, next.gate.id);
    if (decision.resolved) {
      // TAC-06: persist the decision state BEFORE running comment/label cleanup.
      const decided = computeGateDecision(state, next.gate.id, decision);
      await store.save(decided);
      // TAC-07: cleanup is idempotent and can be retried if it fails.
      await postGateDecision(decided, next.gate.id, decision);
      state = decided;
      const updatedNext = computeNextAction(state);
      printResult("resume", { state, nextAction: updatedNext }, updatedNext.detail);
      return;
    }
  }

  printResult("resume", { state, nextAction: next }, next.detail);
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
  },
): Promise<void> {
  const store = await resolveExistingStore(argv);
  let state = await store.load();
  state = upsertGate(state, { id: argv.gateId, type: argv.type, question: argv.question });
  if (argv.type === "human") {
    if (!store.issueRef) {
      throw new Error(
        "human gates require the GitHub-issue backend (--repository + --run-id); the file backend has no tracking issue to attach the gate to",
      );
    }
    state = await openHumanGateIssue({
      runState: state,
      gateId: argv.gateId,
      title: argv.title,
      question: argv.question,
      context: argv.context ?? [],
      runIssue: store.issueRef,
    });
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
    title: string;
    body?: string;
    bodyFile?: string;
    labels?: string[];
    assignee?: string;
  },
): Promise<void> {
  const store = await resolveExistingStore(argv);
  let state = await store.load();

  // Read body from file or direct argument
  let body = argv.body;
  if (argv.bodyFile) {
    body = await readFile(argv.bodyFile, "utf-8");
  }
  if (!body) {
    throw new Error("--body or --body-file is required");
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

  const repository = argv.repository || "";
  const issueRef = await github.createIssue(repository, {
    title: argv.title,
    body: bodyWithNote,
    labels: argv.labels,
  });

  // Attempt assignee: for @github-copilot try the real account name; skip gracefully on failure.
  let assigneeVerified = false;
  const actualAssignee = assignee === "@github-copilot" ? "github-copilot[bot]" : assignee;
  if (assignee) {
    try {
      await github.addAssignees(repository, issueRef.number, [actualAssignee]);
      assigneeVerified = true;
    } catch {
      // Non-fatal: Copilot or assignee may not be available in this repository.
      assigneeVerified = false;
    }
  }

  // TAC-12: verify labels were actually applied by reading the issue back.
  const requestedLabels = argv.labels ?? [];
  let labelsVerified = false;
  if (requestedLabels.length > 0) {
    const created = await github.viewIssue(repository, issueRef.number);
    const actualLabels = new Set(created.labels.map((l) => l.name));
    labelsVerified = requestedLabels.every((l) => actualLabels.has(l));
    if (!labelsVerified) {
      const missing = requestedLabels.filter((l) => !actualLabels.has(l));
      throw new Error(
        `issue-create verification failed: labels not applied on #${issueRef.number}: ${missing.join(", ")}`,
      );
    }
  } else {
    labelsVerified = true;
  }

  // Open the issue-ready gate and store issue number for later phases
  const gateId = "issue-ready";
  state = upsertGate(state, { id: gateId, type: "issue", question: `Implementation issue ${issueRef.number} created and assignee set to ${assignee}` });
  state.issue = issueRef.number;
  const labels = new Set(requestedLabels);
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
      assigneeVerified,
      labelsVerified,
      gate: gateId,
    },
    next.detail,
  );
}

/**
 * TAC-08: Reconcile all open harness gates in a repository. Finds every
 * open tracking issue carrying both `harness:run` and `harness:gate-open`,
 * then applies the same label-timeline-based resume logic for each run.
 * This handles label events that arrived while the trigger workflow was not
 * yet active or had transiently failed (missed-event recovery).
 */
async function cmdReconcile(argv: { repository: string }): Promise<void> {
  const issues = await github.findIssuesWithLabels(argv.repository, [RUN_ISSUE_LABEL, GATE_LABEL]);

  const results: Array<{ issueNumber: number; runId?: string; action?: string; error?: string }> = [];

  for (const issue of issues) {
    try {
      const runState = parseStateFromBody(issue.body);
      const store = new IssueStateStore(argv.repository, issue.number);
      const next = computeNextAction(runState);

      if (next.action === "await-human-gate" && next.gate?.issue) {
        const gateId = next.gate.id;
        const decision = await checkHumanGateIssue(runState, gateId);
        if (decision.resolved) {
          // TAC-06: persist first, then cleanup
          const decided = computeGateDecision(runState, gateId, decision);
          await store.save(decided);
          await postGateDecision(decided, gateId, decision);
          results.push({
            issueNumber: issue.number,
            runId: runState.runId,
            action: `gate '${gateId}' resolved: ${decision.approved ? "approved" : "rejected"}`,
          });
          continue;
        }
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

  printResult("reconcile", { reconciled: results }, `Reconciled ${results.length} open gate(s).`);
}

async function cmdIterationStart(argv: StoreArgs): Promise<void> {
  const store = await resolveExistingStore(argv);
  const state = await store.load();
  const { state: nextState, iteration } = startIteration(state);
  await store.save(nextState);
  printResult("iteration-start", { state: nextState, iteration }, `Iteration ${iteration.index} started.`);
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

await yargs(hideBin(process.argv))
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
        .option("max-automatic-iterations", { type: "number" }),
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
        .option("context", { type: "array", string: true }),
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
        .option("title", { type: "string", demandOption: true, describe: "Issue title" })
        .option("body", { type: "string", describe: "Issue body (Markdown)" })
        .option("body-file", { type: "string", describe: "Path to file with issue body (markdown)" })
        .option("labels", { type: "array", string: true, describe: "Labels to apply" })
        .option("assignee", { type: "string", describe: "Override assignee (defaults to spec's implementation_assignee or @github-copilot)" })
        .check((argv) => {
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
        title: argv.title,
        body: argv.body as string | undefined,
        bodyFile: argv["body-file"] as string | undefined,
        labels: argv.labels as string[] | undefined,
        assignee: argv.assignee as string | undefined,
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
    "reconcile",
    "Find all open harness gates in a repository and apply any pending label decisions (missed-event recovery)",
    (y) => y.option("repository", { type: "string", demandOption: true, describe: "owner/repo to reconcile" }),
    async (argv) => cmdReconcile({ repository: argv.repository as string }),
  )
  .demandCommand(1)
  .strict()
  .parse();
