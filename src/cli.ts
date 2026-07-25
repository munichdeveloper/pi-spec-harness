#!/usr/bin/env node
import { existsSync } from "node:fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  acknowledgeRejectedHumanGate,
  applyGateDecision,
  checkHumanGateIssue,
  openHumanGateIssue,
} from "./gates/human-gate.js";
import { loadRunState, saveRunState } from "./state/store.js";
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

function defaultStatePath(runId: string): string {
  return `artifacts/harness/${runId}.json`;
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
  const path = argv.state ?? defaultStatePath(argv.runId);
  let state: RunState;
  if (existsSync(path)) {
    const existing = await loadRunState(path);
    state = reconcileInit(existing, argv);
  } else {
    state = initRunState(argv);
    await saveRunState(path, state);
  }
  printResult("init", { path, state }, computeNextAction(state).detail);
}

async function cmdStatus(argv: { state: string }): Promise<void> {
  const state = await loadRunState(argv.state);
  const next = computeNextAction(state);
  printResult("status", { state, nextAction: next }, next.detail);
}

async function cmdResume(argv: { state: string }): Promise<void> {
  // resume never mutates state; it only recomputes and, for open human
  // gates, polls the backing GitHub issue for a resolved decision.
  let state = await loadRunState(argv.state);
  const next = computeNextAction(state);

  if (next.action === "await-human-gate" && next.gate?.issue) {
    const decision = await checkHumanGateIssue(state, next.gate.id);
    if (decision.resolved) {
      state = await applyGateDecision(state, next.gate.id, decision);
      await saveRunState(argv.state, state);
      const updatedNext = computeNextAction(state);
      printResult("resume", { state, nextAction: updatedNext }, updatedNext.detail);
      return;
    }
  }

  printResult("resume", { state, nextAction: next }, next.detail);
}

async function cmdGateOpen(argv: {
  state: string;
  gateId: string;
  type: GateType;
  title: string;
  question: string;
  context?: string[];
}): Promise<void> {
  let state = await loadRunState(argv.state);
  state = upsertGate(state, { id: argv.gateId, type: argv.type, question: argv.question });
  if (argv.type === "human") {
    state = await openHumanGateIssue({
      runState: state,
      gateId: argv.gateId,
      title: argv.title,
      question: argv.question,
      context: argv.context ?? [],
    });
  }
  await saveRunState(argv.state, state);
  const next = computeNextAction(state);
  printResult("gate-open", { state, nextAction: next }, next.detail);
}

async function cmdGateResolve(argv: {
  state: string;
  gateId: string;
  result: "passed" | "failed";
  evidence?: string[];
}): Promise<void> {
  let state = await loadRunState(argv.state);
  state = resolveGate(state, argv.gateId, { result: argv.result, evidence: argv.evidence });
  await saveRunState(argv.state, state);
  const next = computeNextAction(state);
  printResult("gate-resolve", { state, nextAction: next }, next.detail);
}

async function cmdPhase(argv: { state: string; phase: PhaseId }): Promise<void> {
  let state = await loadRunState(argv.state);
  state = transitionPhase(state, argv.phase);
  await saveRunState(argv.state, state);
  const next = computeNextAction(state);
  printResult("phase", { state, nextAction: next }, next.detail);
}

async function cmdGateAcknowledge(argv: { state: string; gateId: string; note: string }): Promise<void> {
  let state = await loadRunState(argv.state);
  state = await acknowledgeRejectedHumanGate(state, argv.gateId, argv.note);
  await saveRunState(argv.state, state);
  const next = computeNextAction(state);
  printResult("gate-acknowledge", { state, nextAction: next }, next.detail);
}

async function cmdNote(argv: { state: string; text: string }): Promise<void> {
  const state = await loadRunState(argv.state);
  const notes = [...(state.notes ?? []), `${new Date().toISOString()} ${argv.text}`];
  const next = { ...state, notes, updatedAt: new Date().toISOString() };
  await saveRunState(argv.state, next);
  printResult("note", { state: next }, `Note recorded on run '${next.runId}'.`);
}

async function cmdIterationStart(argv: { state: string }): Promise<void> {
  let state = await loadRunState(argv.state);
  const { state: nextState, iteration } = startIteration(state);
  state = nextState;
  await saveRunState(argv.state, state);
  printResult("iteration-start", { state, iteration }, `Iteration ${iteration.index} started.`);
}

async function cmdIterationFinish(argv: {
  state: string;
  index: number;
  result: "passed" | "failed";
  findings?: string[];
}): Promise<void> {
  let state = await loadRunState(argv.state);
  state = finishIteration(state, argv.index, argv.result, argv.findings);
  await saveRunState(argv.state, state);
  const next = computeNextAction(state);
  printResult("iteration-finish", { state, nextAction: next }, next.detail);
}

await yargs(hideBin(process.argv))
  .scriptName("harness")
  .command(
    "init",
    "Initialize (or idempotently reconcile) a run",
    (y) =>
      y
        .option("run-id", { type: "string", demandOption: true })
        .option("repository", { type: "string", demandOption: true })
        .option("requirement", { type: "string", demandOption: true })
        .option("spec", { type: "string", demandOption: true })
        .option("issue", { type: "number" })
        .option("branch", { type: "string" })
        .option("state", { type: "string" })
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
    (y) => y.option("state", { type: "string", demandOption: true }),
    async (argv) => cmdStatus({ state: argv.state }),
  )
  .command(
    "resume",
    "Recompute next action; poll any open human-gate issue for a decision",
    (y) => y.option("state", { type: "string", demandOption: true }),
    async (argv) => cmdResume({ state: argv.state }),
  )
  .command(
    "gate-open",
    "Register a gate; for type=human this opens a GitHub issue",
    (y) =>
      y
        .option("state", { type: "string", demandOption: true })
        .option("gate-id", { type: "string", demandOption: true })
        .option("type", { type: "string", demandOption: true, choices: ["spec", "issue", "runtime", "review", "human", "merge"] as const })
        .option("title", { type: "string", default: "" })
        .option("question", { type: "string", default: "" })
        .option("context", { type: "array", string: true }),
    async (argv) =>
      cmdGateOpen({
        state: argv.state,
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
      y
        .option("state", { type: "string", demandOption: true })
        .option("gate-id", { type: "string", demandOption: true })
        .option("result", { type: "string", demandOption: true, choices: ["passed", "failed"] as const })
        .option("evidence", { type: "array", string: true }),
    async (argv) =>
      cmdGateResolve({
        state: argv.state,
        gateId: argv.gateId,
        result: argv.result as "passed" | "failed",
        evidence: argv.evidence as string[] | undefined,
      }),
  )
  .command(
    "phase",
    "Force-set the current phase (use sparingly; prefer computeNextAction-driven advancement)",
    (y) =>
      y
        .option("state", { type: "string", demandOption: true })
        .option(
          "phase",
          {
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
          },
        ),
    async (argv) => cmdPhase({ state: argv.state, phase: argv.phase as PhaseId }),
  )
  .command(
    "gate-acknowledge",
    "Acknowledge a rejected human gate (records how the run proceeds after rejection)",
    (y) =>
      y
        .option("state", { type: "string", demandOption: true })
        .option("gate-id", { type: "string", demandOption: true })
        .option("note", { type: "string", demandOption: true }),
    async (argv) => cmdGateAcknowledge({ state: argv.state, gateId: argv.gateId, note: argv.note }),
  )
  .command(
    "note",
    "Append a free-form, hygiene-checked note to the run",
    (y) =>
      y
        .option("state", { type: "string", demandOption: true })
        .option("text", { type: "string", demandOption: true }),
    async (argv) => cmdNote({ state: argv.state, text: argv.text }),
  )
  .command(
    "iteration-start",
    "Start a new automatic correction iteration",
    (y) => y.option("state", { type: "string", demandOption: true }),
    async (argv) => cmdIterationStart({ state: argv.state }),
  )
  .command(
    "iteration-finish",
    "Finish the current iteration",
    (y) =>
      y
        .option("state", { type: "string", demandOption: true })
        .option("index", { type: "number", demandOption: true })
        .option("result", { type: "string", demandOption: true, choices: ["passed", "failed"] as const })
        .option("findings", { type: "array", string: true }),
    async (argv) =>
      cmdIterationFinish({
        state: argv.state,
        index: argv.index,
        result: argv.result as "passed" | "failed",
        findings: argv.findings as string[] | undefined,
      }),
  )
  .demandCommand(1)
  .strict()
  .parse();
