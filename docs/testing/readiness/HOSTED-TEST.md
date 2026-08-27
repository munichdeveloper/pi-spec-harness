# SPEC-016 hosted synthetic proof

Status: prepared, **not yet executed on GitHub**. Local subprocess and simulated
API tests are not evidence that workflow dispatch/resume works on hosted runners.

## Scope

Only `munichdeveloper/pi-spec-harness`; no paid provider, Immogent access or real
mail/offer data. `SPEC-900001.md` is synthetic input, not a business approval.
The agent fixture emits a coordinate sample; a separate verifier checks exact
values. The implementation fixture performs a deterministic local computation.
This verifies orchestration, not Copilot/Claude coding capability.

## Bootstrap and configuration

The two new workflows must first be registered on the default branch through an
authorized merge. Current PR #120 is a draft; the prior release milestone's merge
authorization is not reused. Keep `HARNESS_READINESS_ENABLED` unset/false until
configuration and the exact runtime commit have been reviewed.

For this isolated test set:

- `HARNESS_READINESS_SYNTHETIC=true`
- `HARNESS_READINESS_RUNTIME_SHA`: exact tested commit containing code and fixtures
- `HARNESS_READINESS_RUNTIME_BRANCH`: dedicated branch pointing to that commit;
  do not use the audit journal branch
- `HARNESS_READINESS_EXECUTOR_WORKFLOW_ID`: registered numeric executor workflow ID
- `HARNESS_READINESS_SOURCE_BRANCH`: branch containing the synthetic spec (default main)
- `HARNESS_READINESS_ENABLED=true` only when ready to execute

The workflow generates config in its ephemeral checkout. The synthetic producer
allowlist uses the API-verified `github-actions[bot]` user ID `41898282`.
Dispatch the reconcile workflow, not the executor directly; only the controller
may bind work and choose an executor.
The executor rejects an absent canonical receipt, a different receipt/executor or
spec revision, duplicate work identities and malformed Actions attempt numbers
before starting even the availability probe. These checks are covered locally;
hosted validation remains pending bootstrap approval.

## Required evidence before claiming success

1. Real run/implementation/spike issues with one canonical run and stable bindings.
2. Successful hosted spike execution and attempt-bound result artifact.
3. Automatic workflow_run continuation to implementation without a second approval.
4. Persisted implementation fixture output and both execution audit events.
5. Repeated reconcile does not create another issue or execute work again.
6. Cancellation-before-claim recovers within the retry bound; uncertain claimed
   execution instead requests reconciliation and never repeats agent work.
7. Quota-unavailable fixture blocks before agent start and resumes when available.
8. Failed/incomplete/stale spike results do not authorize implementation.
9. All claimed events are present in the canonical audit journal, not just queued.

Record workflow URLs, run-issue URL, artifact IDs, attempts and journal paths here
after verification. Disable synthetic execution when testing is complete; retain
issues/artifacts as evidence within their retention periods.
