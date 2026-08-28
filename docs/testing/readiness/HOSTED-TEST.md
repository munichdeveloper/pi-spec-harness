# SPEC-016 hosted synthetic proof

Status: hosted verification **in progress**. Bootstrap PR #120 was explicitly
approved and squash-merged on 2026-08-28 as
`f34d1e7d7d75f147bc98a273505f1462409c0bee`; post-merge CI
[33159260635](https://github.com/munichdeveloper/pi-spec-harness/actions/runs/33159260635)
passed. The first hosted controller is
[33159287185](https://github.com/munichdeveloper/pi-spec-harness/actions/runs/33159287185).
This is not yet evidence of a completed spike-to-implementation cycle.

The isolated runtime is `runtime/spec016-synthetic` at
`3a7f69d28287d0ab6354ea62dc3018200d9a5b10`; registered executor workflow ID:
`344477441`. Synthetic configuration was enabled only in this Harness repository.
The canonical synthetic run is [#121](https://github.com/munichdeveloper/pi-spec-harness/issues/121),
with implementation fixture [#122](https://github.com/munichdeveloper/pi-spec-harness/issues/122).
No Immogent configuration or paid provider was activated.

### First hosted result and observed gap (2026-08-28)

- Controller 33159287185 passed in 5m36s and automatically dispatched
  [spike executor 33159597244](https://github.com/munichdeveloper/pi-spec-harness/actions/runs/33159597244).
- [Spike #123](https://github.com/munichdeveloper/pi-spec-harness/issues/123) was
  created and bound to attempt 1; executor succeeded in 2m25s.
- Result artifact ID `9681150746`, name
  `readiness-result-8c96eadfe8198452b37a29eaac951f7473de31756e5a619aeb4c87dfd87b00b8-1`,
  was uploaded (14-day retention).
- **No workflow_run continuation was observed after successful completion.**
  Consequently implementation continuation is not verified. The executor actor
  and triggering actor are both `github-actions[bot]`.
- Synthetic execution was disabled while fixing this gap. No manual controller
  re-run was used to disguise the missing automatic event.
- Add an explicit same-repository `repository_dispatch` notification after
  executor completion, including failed execution/artifact publication when the
  trusted build succeeded. The receiver ignores payload for decisions and reloads
  canonical state, producer identity, conclusion and artifact bindings. Scheduler
  remains fallback for cancellation or notification failure; shared lock prevents
  overlapping state writes. Hosted verification of this fix remains pending.
- Audit confirmations currently scan the journal sequentially (94+ entries),
  taking roughly a minute per confirmation in this run. This is a measured
  scalability concern, not an approval wait.

GitHub documents `workflow_dispatch` and `repository_dispatch` as exceptions to
GITHUB_TOKEN recursive-trigger suppression:
[Triggering a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
The observed missing cascade is treated as a transport failure, not permission to
skip result verification or use a more privileged personal token.

## Scope

Only `munichdeveloper/pi-spec-harness`; no paid provider, Immogent access or real
mail/offer data. `SPEC-900001.md` is synthetic input, not a business approval.
The agent fixture emits a coordinate sample; a separate verifier checks exact
values. The implementation fixture performs a deterministic local computation.
This verifies orchestration, not Copilot/Claude coding capability.

## Bootstrap and configuration

The two new workflows must first be registered on the default branch through an
authorized merge. PR #120 received separate bootstrap authorization; the prior
release milestone's merge authorization was not reused. Keep `HARNESS_READINESS_ENABLED` unset/false until
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
hosted validation is tracked below and must not be inferred from local tests.

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
