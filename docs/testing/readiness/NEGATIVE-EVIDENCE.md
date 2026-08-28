# Hosted negative evidence tests

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
