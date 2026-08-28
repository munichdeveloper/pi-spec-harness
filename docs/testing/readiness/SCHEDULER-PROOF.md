# Scheduler-only quota recovery proof

Status: prepared, not yet verified. Identity SPEC-900011, runtime branch
`runtime/spec016-scheduler-v12`. Fixture filename remains SPEC-900001.md.

Start with `quota-unavailable`, enable only after source and runtime point to
the same tested commit. Do not manually dispatch the controller. Wait for a
GitHub `schedule` event and verify canonical `await-executor`, no work receipt
and confirmed audit. Then set scenario to `success` without dispatching a
controller. Require a subsequent scheduled event to discover availability and
initiate work; completion notifications may drive downstream steps.

Record controller IDs/event types, canonical issue, producer attempts, verified
evidence, implementation output and confirmed audit records. Require idempotent
follow-up, then disable readiness and read back false. Preserve previous tests.
If GitHub delays scheduling, leave the result pending; do not replace it with a
manual dispatch or claim that a timer configuration proves actual execution.

This is a synthetic zero-cost orchestration test, not provider coding or full
product lifecycle acceptance. The milestone's explicit autonomous merge and
public metadata audit consent applies. No Immogent writes or releases.
