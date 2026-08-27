---
id: SPEC-016
type: software-spec
title: Deterministic readiness and durable spike reconciliation
status: draft
requirements:
  - REQ-016
---

# SPEC-016

Implementation design for milestone 2 / issue 119. The user authorized work on
the milestone; this draft is not a fabricated GitHub human-gate decision.

## Contract

Readiness metadata version 1 is bound to an immutable spec revision. Each
blocker has a stable ID, stage (`implementation`, `deployment`, `deferred`),
kind (`technical`, `decision`), explicit owner, question, acceptance criteria
and a positive execution budget. A missing legacy contract is unclassified,
not ready. Do not classify free-form prose by keyword heuristics.

A pure evaluator returns the next responsibility and machine-readable reason:
`await-approval`, `classify`, `human-decision`, `spike`, `await-executor`, or
`implement`. It performs no GitHub I/O and never trusts issue closure as proof.

Spike evidence is supplied only by a trusted verification adapter, never
directly from a comment or issue body without provenance validation. Evidence
must match the revision and blocker, include references, cover every criterion,
and indicate whether scope/cost/privacy changes require human review. Stale,
failed or incomplete evidence cannot unblock implementation.

Executor policy is trusted repository configuration: explicit authorization,
current availability, deterministic preference order, configured capabilities,
and a finite per-task cost ceiling. Availability is checked again at dispatch.
No date-based quota reset assumption and no implicit fallback.

## Durable integration (required before completion)

1. Validate exact approved spec revision and structured readiness.
2. Reconcile existing issue by exact identity; ambiguous matches stop safely.
3. Persist canonical run and prepared side-effect intent before dispatch.
4. Idempotently provision owned status labels and linked spike work.
5. Select and dispatch a configured executor explicitly; do not rely on
   GITHUB_TOKEN label changes cascading into other workflows.
6. Receive trusted verified spike evidence; evaluate the same run again.
7. Confirm canonical SPEC-005 audit before committing the transition.

GitHub mutations must use named methods in `src/github/gh.ts`. Retry and
reconciliation must preserve unrelated labels and user content. Execution labels
are applied only when readiness and executor policy both permit implementation.
SPEC-007 AC-08 remains the default until this opt-in policy is integrated; it is
superseded only for the new fully validated handoff path.

## Verification

- TAC-01: Pure evaluator tests cover all dispositions and malformed policies.
- TAC-02: Deployment/deferred questions do not block implementation.
- TAC-03: Missing, stale, partial, failed and decision-changing spike evidence
  cannot authorize implementation; matching complete evidence can.
- TAC-04: Unavailable, unauthorized or over-budget executors cannot be selected.
- TAC-05: Durable integration tests cover duplicate events and crash recovery.
- TAC-06: The actual CLI/workflow entry point is exercised in synthetic E2E;
  a pure evaluator test alone is not end-to-end proof.

## Delivery status

In progress. Pure decision logic and a checkpointed coordinator are implemented.
The coordinator persists prepared work in the existing run, reconciles accepted
dispatches before retrying, confirms dispatch/result audit before progression,
and rechecks executor availability immediately before dispatch. The tracking
issue renders the current decision, work owner and pending evidence.

Port-integration tests cover duplicate invocations, dispatch-before-crash,
audit failure, quota loss, stale results and retry exhaustion. These are not
workflow E2E tests. The concrete issue adapter now uses the paginated REST issue
listing (including closed issues, excluding PRs), adopts exact legacy spec issues
without rewriting user content, and rejects ambiguous or conflicting identities.
Spike issues carry owner, executor, question, criteria, revision and attempt limit;
closure never constitutes evidence. Lost creation responses are recovered through
the durable marker. Callers must serialize reconciliation and confirm issue audit.
No execution labels or providers are activated by issue materialization alone.

Canonical bootstrap now adopts existing runs by exact spec/binding rather than
by a generated title alone, preserving legacy names and progress. It creates a
single issue-backed run with revision-bound spec provenance when none exists.
Duplicate, closed, malformed or conflicting runs stop reconciliation; an advanced
legacy run cannot silently dispatch a competing implementation. Trusted approval
verification remains the entry point's responsibility, not an inference from chat.

The workflow evidence adapter validates repository, numeric actor identities,
workflow ID/path and pinned revision, dispatch identity, run attempt and an exact
non-expired bounded result artifact. It rechecks the run after retrieval to detect
rerun races. Payload binding covers work key, executor, issue, spike attempt,
blocker and spec revision. Failed research and boundary changes remain explicit.
The approved producer workflow must independently verify criteria before emitting
this artifact; agent self-reports are not an implementation of that verifier.

The executable receiver now persists a work claim before starting a configured
command, then invokes a separately configured verifier for spike criteria. JSON
stdin separates task data from commands; no shell or implicit environment is used.
Input/output sizes and subprocess runtime are bounded. Results are hygiene-checked
before persistence and completed work reuses its durable output. Interrupted or
failed claims require reconciliation rather than blindly duplicating agent work.
The workflow runner must contain descendant processes; the command timeout alone
is not a provider-spend limit or a general sandbox. Provider budget enforcement
and trusted command configuration remain deployment responsibilities.

Tests execute actual synthetic Node subprocesses for agent and verifier, including
negative and duplicate-delivery cases. They are not GitHub workflow E2E evidence.

The `readiness-execute --repository OWNER/REPO --run-issue N --work-key KEY
--receipt github-actions:RUN_ID --config TRUSTED_CONFIG` CLI command now binds
execution to the GitHub Actions runtime, loads the canonical tracking issue,
validates repository/spec revision and confirms execution audit in the journal.
Configuration is executable authority and must come from a verified trusted
checkout, never the work branch or agent output. The workflow integration must
enforce this checkout policy and the shared concurrency lock. Configuration
contains schemaVersion, repository, costCeiling, policy, contract, agent,
optional verifier, and audit.directory/audit.branch. Command environments are
explicit; do not commit credential values into configuration.

The dispatch adapter now explicitly submits workflow_dispatch and resolves the
actual run ID through the paginated Actions API. It reuses trusted matching runs,
recovers accepted requests with lost HTTP responses, validates canonical receipts,
and rejects a moved workflow branch before submission. Lookup is bounded per
attempt; delayed visibility produces a retriable reconciliation error, never a
fabricated receipt. Duplicate transport runs are possible after ambiguous delivery;
the receiver's canonical receipt/claim and shared lock must prevent duplicate work.

Remaining orchestration CLI/workflow integration, configured criterion-verifying
producer workflow and synthetic workflow E2E remain
mandatory milestone work; no consumer activation before those are verified.
