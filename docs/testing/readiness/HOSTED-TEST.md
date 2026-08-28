# SPEC-016 hosted synthetic proof

Status: positive hosted synthetic cycle **verified** on 2026-08-28 (SPEC-900004,
run #132). Hosted negative-path coverage remains incomplete; this is not a full
release-readiness or real-provider proof. Bootstrap PR #120 was explicitly
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
3. Automatic executor-completion notification and continuation to implementation
   without a second approval (explicit repository_dispatch; workflow_run is supplementary).
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

## PR #124 hosted verification (2026-08-28)

PR #124 was explicitly authorized and merged as
`5c6bfbf811afabb175ee13ed66d8f44383728384`.
[Post-merge CI 33173722961](https://github.com/munichdeveloper/pi-spec-harness/actions/runs/33173722961)
passed. Runtime `runtime/spec016-synthetic-v2` used a fresh synthetic identity
SPEC-900002; the prior run's receipts and evidence were not rewritten.

- [Controller 33173751573](https://github.com/munichdeveloper/pi-spec-harness/actions/runs/33173751573)
  automatically created run #125, implementation #126 and spike #127.
- [Executor 33174075980](https://github.com/munichdeveloper/pi-spec-harness/actions/runs/33174075980)
  passed; artifact `9686894918` bound to attempt 1 was uploaded.
- **Automatic notification proved:**
  [controller 33174295288](https://github.com/munichdeveloper/pi-spec-harness/actions/runs/33174295288)
  started via `repository_dispatch`, with no manual continuation.
- **Negative audit-contract proof:**
  [receiver 33174349874](https://github.com/munichdeveloper/pi-spec-harness/actions/runs/33174349874)
  rejected `synthetic:coordinate-fixture-v1` because evidence must use HTTPS.
  Controller failed after bounded confirmation retries. No implementation work
  was authorized. Run #125 retains the rejected pending event for diagnosis;
  it is not a complete run and its audit event was not confirmed.
- Fixture corrected to an immutable HTTPS link to the actual synthetic agent
  source; a regression assertion now checks HTTPS evidence. Full local check:
  720 tests passed. This changes test data, not the runtime approval policy.
- Repeated in a new isolated identity SPEC-900003 on
  `runtime/spec016-synthetic-v3` (`e9a37ce`), controller
  [33174669002](https://github.com/munichdeveloper/pi-spec-harness/actions/runs/33174669002),
  canonical run [#128](https://github.com/munichdeveloper/pi-spec-harness/issues/128).
  Controller passed; implementation #129 and spike #130 were automatically bound.

### SPEC-900003 outcome and API-limit finding

- [Spike executor 33174955227](https://github.com/munichdeveloper/pi-spec-harness/actions/runs/33174955227)
  passed; artifact `9687245936`, attempt 1, was independently verified by the controller.
- Both a scheduled controller and completion notification arrived. Shared concurrency
  serialized them; redundant pending notification 33175179822 was cancelled when
  the canonical implementation dispatch replaced it. This did not duplicate work.
- [Scheduled controller 33175095639](https://github.com/munichdeveloper/pi-spec-harness/actions/runs/33175095639)
  passed, persisted verified spike evidence, changed readiness to `implement` and
  dispatched [implementation executor 33175418819](https://github.com/munichdeveloper/pi-spec-harness/actions/runs/33175418819)
  without another approval or manual continuation.
- Implementation completed with `{ "synthetic": true, "implementationResult": 10 }`
  at `2026-08-28T13:29:15.328Z`, persisted in run #128. **The Actions job failed
  afterwards**: repeated full-journal reads exhausted the installation API limit
  (HTTP 403). Do not rerun the agent to repair this acknowledgement failure.
- The failure notification still automatically launched controller 33175617524;
  it also failed while the same API quota was exhausted. Synthetic execution was
  disabled (`HARNESS_READINESS_ENABLED=false`) to prevent fruitless retries.
- Independent read-only verification against `origin/main` confirmed **all 12
  run-128 audit events** exist, including execution completion at
  `docs/process-audit/journal/20260828T132915Z-010687b44200da17.md`, confirmed at
  `2026-08-28T13:29:30.097Z`. Thus delivery succeeded but producer acknowledgement
  failed. No event or completed work record was rewritten.
- Fix prepared: prioritize canonical filename hash candidates, validate the full
  idempotency key and canonical confirmation timestamp, retain legacy-name support
  and one exhaustive final fallback. Tests cover a 1,000-file journal, delayed
  delivery, renamed history, hash collision, malformed confirmation and HTTP errors.
  Full local check: **727 tests passed**. Hosted verification of this performance
  fix and a fully green terminal/idempotent reconciliation remain outstanding.

Remaining hardening findings: deploy and verify the indexed audit lookup; invalid evidence
should be rejected before delivery and expose an actionable disposition; blocked
historical test runs require explicit evidence-preserving retirement. Dependency
installation reported eight existing advisories (three moderate, four high, one
critical); no blind or breaking dependency update was performed during this test.

## PR #131 recovery and successful SPEC-900004 cycle

The authorized retry of binding check 33175851931 passed on attempt 2 (one
retry). PR #131 was squash-merged with exact-head guard for
`7bfe3c691611852bfebafa9e498e6243637f805f`, producing
`b7180b108af20030b7e48902150267260b41cbc4`. Post-merge CI
[33180260100](https://github.com/munichdeveloper/pi-spec-harness/actions/runs/33180260100)
passed. No protection bypass was used.

Source and runtime were both pinned to
`72306342b83f8a351b0903a60179681d30827451` on
`runtime/spec016-synthetic-v4`. Only fixture identity changed to SPEC-900004;
the generator path remains `docs/testing/readiness/SPEC-900001.md`.

| Stage | Evidence | Result |
| --- | --- | --- |
| Initial controller | [33180307841](https://github.com/munichdeveloper/pi-spec-harness/actions/runs/33180307841) | Success, 2m15s; canonical run #132, implementation #133, spike #134 |
| Spike executor | [33180477288](https://github.com/munichdeveloper/pi-spec-harness/actions/runs/33180477288) | Success, 53s; artifact 9689501417, attempt 1 |
| Automatic verification/continuation | [33180594030](https://github.com/munichdeveloper/pi-spec-harness/actions/runs/33180594030) | Independently verified spike; automatically dispatched implementation |
| Implementation executor | [33180718465](https://github.com/munichdeveloper/pi-spec-harness/actions/runs/33180718465) | Success; persisted synthetic output `implementationResult: 10` |
| Automatic idempotent follow-up | [33180837407](https://github.com/munichdeveloper/pi-spec-harness/actions/runs/33180837407) | Success via repository_dispatch; `observe-work`, `implementation-already-dispatched` |

The canonical [run #132](https://github.com/munichdeveloper/pi-spec-harness/issues/132)
contains exactly two work records, both attempt 1 and execution completed.
Spike evidence is bound to spec blob `d8200245e15f8b65f8803c4cbea8b5e7d43ae9a7`
and producer run/attempt. No manual continuation after the initial controller
dispatch and no repeated agent work were needed.

All 12 run audit records were independently read from `origin/main`, including:

- verified result: `docs/process-audit/journal/20260828T143202Z-bd8491f6dca5897c.md`;
- implementation completed: `docs/process-audit/journal/20260828T143400Z-1d56671c98c8cb79.md`,
  confirmed at `2026-08-28T14:34:11.394Z`.

`HARNESS_READINESS_ENABLED=false` was set and read back after verification.
Historical runs #121/#125/#128, receipts and evidence remain untouched.
No Immogent writes, real AI provider calls, releases or paid resources were used.

This closes the positive-cycle and indexed-lookup hosted proof, not the entire
milestone. Required-evidence items 6-8 above still need comprehensive hosted
negative-path tests. The readiness checkpoint observes completed work; it does
not yet close the overall tracking run or retire the spike issue. Real-provider
coding capability is deliberately not claimed by this deterministic fixture.

## Negative-fixture preparation

The local synthetic config generator accepts an explicit
`HARNESS_READINESS_SYNTHETIC_SCENARIO`: `success` (default),
`quota-unavailable`, `invalid-coordinates`, `incomplete-result`, or
`agent-failure`. Unknown values fail closed. The scenario is passed through
the subprocess environment allowlist; no ambient credential is forwarded.
The independent verifier is unchanged: bad or missing coordinates fail.
Quota-unavailable both reports unavailable and refuses direct execution.
Agent-failure reports available but exits unsuccessfully during execution.

These fixtures are preparation, not hosted evidence. Both workflows forward
the scenario variable only to their synthetic config preparation step.
Before activation, bind both source and runtime to
the reviewed test commit and allocate a new identity per independent scenario.
Keep previous canonical runs and evidence unchanged. Quota recovery must stay
on the same identity; changing runtime identity must not invalidate its receipt.
Cancellation-before-claim and stale artifact tests require separate transport
and artifact fault injection; agent-failure is not a substitute for either.
Do not weaken production verification to make a negative fixture pass.

### Delayed audit acknowledgement

Readiness reconciliation now distinguishes bounded acknowledgement expiry
(`AuditConfirmationPendingError`) from permission, transport and malformed
journal failures. Only acknowledgement expiry returns `await-audit` with the
exact idempotency key and a 600-second retry hint. It does not mark delivery
confirmed or authorize downstream work. Original audit intents remain in the
canonical issue body and are drained before new decisions, including when quota
has changed. Replays preserve event timestamps and payloads.

The existing ten-minute schedule supplies automatic continuation while readiness
is enabled; the hint does not create a separate timer. If readiness is disabled,
an operator must re-enable it after diagnosis. Real API/schema failures still
fail visibly. This controller fix does not change executor-side error handling.
Hosted verification is still required; local tests simulate delayed delivery,
changed availability and permission failure.
