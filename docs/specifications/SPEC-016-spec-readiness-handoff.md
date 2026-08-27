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

In progress. The first implementation unit is the pure decision contract.
Run persistence, issue reconciliation, workflow dispatch, audit and E2E remain
mandatory milestone work; no consumer activation before those are verified.
