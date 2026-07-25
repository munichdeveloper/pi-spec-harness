#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import yargs, { type Argv } from "yargs";
import { hideBin } from "yargs/helpers";
import {
  acknowledgeRejectedHumanGate,
  applyGateDecision,
  checkHumanGateIssue,
  openHumanGateIssue,
} from "./gates/human-gate.js";
import { github } from "./github/gh.js";
import { getSpecAssignee } from "./spec/spec-parser.js";
import { ensureRunIssue, findRunIssue } from "./state/issue-store.js";
import type { StateStore } from "./state/state-store.js";
import { FileStateStore } from "./state/store.js";
import {
  computeNextAction,
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
      state = await applyGateDecision(state, next.gate.id, decision);
      await store.save(state);
      const updatedNext = computeNextAction(state);
      printResult("resume", { state, nextAction: updatedNext }, updatedNext.detail);
      return;
    }
  }

  printResult("resume", { state, nextAction: next }, next.detail);
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

  const next = computeNextAction(state);
  printResult("phase", { state, nextAction: next }, next.detail);
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
      argv.body,
    ].join("\n");
  }

  const issueRef = await github.createIssue(argv.repository || "", {
    title: argv.title,
    body: bodyWithNote,
    labels: argv.labels,
  });

  // Assign it (skip for @github-copilot, which GitHub doesn't support as a real assignee)
  if (assignee && assignee !== "@github-copilot") {
    await github.addAssignees(argv.repository || "", issueRef.number, [assignee]);
  }

  // Open the issue-ready gate
  const gateId = "issue-ready";
  state = upsertGate(state, { id: gateId, type: "issue", question: `Implementation issue ${issueRef.number} created and assignee set to ${assignee}` });
  await store.save(state);

  const next = computeNextAction(state);
  printResult(
    "issue-create",
    { issueNumber: issueRef.number, issueUrl: issueRef.url, assignee, gate: gateId },
    next.detail,
  );
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
  .demandCommand(1)
  .strict()
  .parse();
