# Hosted negative evidence tests

## Scheduler-only quota recovery: verified 2026-08-28

SPEC-900011/run158 used runtime8977eb26512984a7cd15fec4882984404e4eb62c.
Schedule33215844110 created await-executor with no work while quota was unavailable.
Availability was restored at22:21:10.825Z; schedule33216891586 at22:27:47Z
automatically dispatched spike160/executor33216972816. Artifact9703736171
was verified by automatic controller33217042570, which dispatched
implementation33217133065. Its persisted output is result10; automatic follow-up
33217219904 returned observe-work/implementation-already-dispatched.
Exactly two work records, both attempt1. No manual controller dispatch at all.
Audits confirmed on main; readiness disabled and false read back.
Completion audit key: spec016:scheduler-v12:verified:v1.

## Scheduler recovery after pre-job cancellation: verified 2026-08-28

SPEC-900012/run161 used runtime0adac8f8f91d1d0faced65783daac27668b96063.
Initial setup controller33217831770 was manually dispatched once. A bounded
observer cancelled executor33217963640 at22:44:57.565Z after verifying exact
SHA, pending status, attempt1 and zero jobs. API confirmed cancelled/jobs=0;
canonical work had no execution claim. This setup is not the recovery proof.

Schedule33218394205 at22:51:53Z automatically submitted exactly one recovery
at22:52:18.432Z. Same receipt, Actions attempt2, logical spike attempt1.
Executor succeeded; artifact9704272397 is bound to attempt2. Automatic controller
33218503913 verified it and dispatched implementation33218572385, which persisted
result10 at22:55:53.947Z. Automatic follow-up33218657725 returned observe-work /
implementation-already-dispatched. No manual recovery dispatch or rerun.

All ten controller audit keys plus four execution claim/completion events were
independently confirmed on main608f114. Exactly two completed work records and
one transport recovery submission. Readiness disabled and false read back.
Previous runs, including the earlier manually initiated recovery proof, remain
unchanged. Neither proof closes the overall product lifecycle: hosted stale
evidence coverage and explicit synthetic lifecycle disposition remain outstanding.

## Stale evidence: read-only live API proof

`npm run build && node scripts/verify-readiness-stale-evidence.mjs` passed
against real retained artifact9701648752 from run154/producer33211011952.
The production evidence reader accepted the actual spec binding and rejected
the same artifact with a different expected spec revision. Canonical issue body
was verified unchanged. No agent was started or artifact replaced. This is live
API contract verification, not a full hosted workflow with a spec changed mid-run.
The script intentionally fails if the retained fixture expires or changes.

### Hosted stale-artifact fault injection

The executor supports the explicit repository variable
`HARNESS_READINESS_SYNTHETIC_STALE_ARTIFACT=true` solely for an isolated hosted
Harness test. It is inert unless synthetic mode is also exactly `true` and the
repository is exactly `munichdeveloper/pi-spec-harness`; invalid activation fails
closed. After canonical synthetic execution it changes only the uploaded copy's
`specRevision`. The canonical execution result and production evidence reader are
unchanged. A successful negative proof therefore requires the automatic controller
to reject the artifact binding and must show that no implementation was dispatched.
This simulates stale artifact transport; it is not evidence of a real product spec
being edited during an execution.

Hosted proof SPEC-900013/run166 used runtime
`c08629d0e2c3ab944dde6aa13ee36a8b6a3bc411`. Executor
33228732382 uploaded retained artifact9707767147; automatic
repository-dispatch reconciliation33228780286 rejected it with `Invalid or
incorrectly bound readiness result`. No implementation work was dispatched.
Readiness and the fault flag were disabled and read back. Completion audit key:
`spec016:stale-v14:verified:v1`.

## Evidence-preserving synthetic disposition

`readiness-dispose-synthetic` is restricted to `SPEC-9xxxxx` readiness runs.
It persists a durable disposition before side effects, rejects claimed work,
closes only the implementation/spike child issues, and records each closure for
idempotent crash recovery. The canonical `harness:run` tracking issue stays open
at its authoritative product phase with all work, results and Evidence intact.
The command therefore retires test infrastructure without turning a completed
fixture subprocess into product review, test, merge or completion evidence.

The merged implementation in PR169 (`8f1c439c42a2c648ee9cb287087d0f891cac9f31`)
passed post-merge CI33229420002. It was applied to run166 as `negative-proof`:
the canonical tracking issue remains open in phase `issue`; implementation issue167
and spike168 are closed with their evidence retained. An identical second command
was a no-op for external side effects. Audit key:
`spec016:run166:lifecycle-disposed:v1`.

## SPEC-016 milestone disposition

The authorized hosted milestone is complete within its stated synthetic,
zero-cost scope. Evidence now covers the positive automatic cycle, indexed audit
lookup, scheduler-only recovery after provider availability returns, scheduler
recovery after pre-job cancellation, invalid/incomplete/failed agent outcomes,
hosted stale-artifact rejection before implementation, and evidence-preserving
synthetic lifecycle disposition. This proves Harness orchestration and its safety
boundaries, not real-provider coding quality or a completed product delivery.
`HARNESS_READINESS_ENABLED=false` and the stale-artifact fault flag is false.

## Autonomous milestone continuation

User authorized autonomous implementation and PR merges for this overall
Harness milestone. Preserve the zero-cost scope and separation from Immogent.
Next acceptance work: automatic scheduler wakeup, lifecycle disposition of
completed/blocked synthetic runs and spikes, durable publication of evidence.
Do not mark a product run complete merely because an implementation subprocess
returned output: review, tests, merge and post-merge gates still apply.
Execution summaries distinguish completed/failed/claimed work from waiting
without changing the authoritative lifecycle or closing tracking issues.

## Workflow cancellation before claim: verified 2026-08-28

The first attempted identity SPEC-900009/run151 was NOT cancelled: local
approval tooling hit a usage limit before cancellation. The run continued
successfully (spike33193035851, implementation33193260380). Preserve it as
ordinary positive evidence, never claim it as cancellation evidence.

Retest SPEC-900010/run154 used runtime11ea45c on runtime/spec016-cancel-v11.
Controller33210854679 dispatched spike33211011952. A bounded local observer
validated branch/SHA, queued status and zero jobs before requesting cancellation.
GitHub confirmed cancelled with jobs=[], and canonical work had no execution.

Recovery controller33211063937 was manually dispatched once; this does not
prove automatic scheduler detection of a never-started cancelled workflow.
It automatically submitted exactly one rerun of receipt github-actions:33211011952.
Actions attempt2 succeeded; logical spike attempt remained1. Artifact9701648752
is bound to Actions attempt2. Automatic controller33211223809 verified it and
dispatched implementation33211311414, completed with synthetic result10.
Automatic follow-up33211426108 returned observe-work/implementation-already-dispatched.

Exactly two logical work records, one recovery submission, no repeated agent
execution. All 14 automatic run154 audit events confirmed on origin/main9e279de.
Readiness disabled and false read back. Explicit cancellation action is recorded
locally below, not counted among the 14 automatic events. Remaining coverage:
stale evidence and automatic scheduler wakeup after pre-job cancellation.

## Agent failure after availability: verified 2026-08-28

SPEC-900008, canonical run148, spike150, runtime dd56cfc on
runtime/spec016-agent-failure-v9. Controller33192306861 succeeded.
Executor33192452753 intentionally failed after the canonical claim; stored
execution.status is failed with timestamps, no provider output. Its automatic
repository_dispatch continuation33192582207 succeeded and set human-decision /
agent-execution-outcome-requires-reconciliation. Exactly one work record,
spike attempt1, original Actions run_attempt1; no retry or implementation.
All nine run events confirmed on origin/main c791953. Readiness disabled.
This is an intentional bounded subprocess failure, not a real process kill or
workflow cancellation; those fault modes are not inferred from this result.

## Invalid coordinates: verified 2026-08-28

SPEC-900006, canonical run140, runtime299b853 on runtime/spec016-invalid-v7.
Controller33190850096 created the isolated run. Executors33191020632 and
33191249311 completed spike attempts1 and2, both independently verified failed.
Automatic controllers33191140307 and33191370904 consumed evidence and stopped
at human-decision/spike-attempt-budget-exhausted-or-invalid. No implementation
work was created. All 14 run audit records were read with confirmed_at from
origin/main76876cb. Disabled readiness before switching scenario.

## Incomplete result

SPEC-900007, runtimeb1a9403 on runtime/spec016-incomplete-v8, initial
controller33191536597. Canonical run144, implementation issue145.
Executors33191699319 and33191938511 completed attempts1 and2, both verdict
failed. Automatic controllers33191815940 and33192069873 consumed evidence;
the latter succeeded and persisted human-decision with reason
spike-attempt-budget-exhausted-or-invalid. Exactly two spike work records,
no implementation work. All 14 run events confirmed on origin/main813dcd0.
Readiness disabled and false read back after completion.

All data and executors are synthetic. No paid provider, consumer changes or
historical execution replay. A green executor means it produced a valid
negative verdict, not that the deliberately invalid candidate passed.
