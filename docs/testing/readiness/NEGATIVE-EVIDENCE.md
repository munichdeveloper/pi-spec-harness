# Hosted negative evidence tests

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
