# RUN-003: Reliable human gates

## Scope

- Requirement: `REQ-002`
- Software specification: `SPEC-002`
- Tracking issue: `#7`
- Implementation issue: `#8`
- Delivery pull request: `#6`
- Implementation pull request: `#9`

## Implementation and review

PR #9 implemented the approved SPEC-002 scope. Six P1 review findings were
addressed and resolved:

1. structured decision context is accepted by `gate-open` and persisted;
2. gate publication uses durable `prepared`, `publishing`, and `open`
   checkpoints;
3. decision cleanup is represented by durable `cleanupPending` state and is
   independently retryable;
4. conflicting decisions are evaluated against both the event timeline and
   the currently active labels;
5. a changed PR head invalidates a SHA-specific human merge approval;
6. Coding Agent assignment changes were removed from SPEC-002 and remain in
   SPEC-003.

An additional pre-merge review found and fixed a retry race: after the
`publishing` checkpoint, a retry no longer removes a newly applied human
decision.

PR #9 was merged at exact head
`cc5d66f18885a4af06e551de190a3aa8f57fc2cb` into the delivery branch as
commit `979121cf9da7f9cd9acaf77d9dde3a9d6f00f2da`.

## Verification

- `npm run check`: typecheck, lint, and 57 tests passed.
- GitHub CI passed on the delivery head.
- GitGuardian passed on the delivery head.
- All six review threads are resolved.

### Missed-event reconciliation smoke

A fully synthetic tracking issue `#17` was used. Its `harness:run` label was
temporarily absent when `harness:gate-approved` was applied, so the label
event was deliberately not processed by the fast event path. The issue state
remained `needs-human` until an explicit `reconcile` run:

- the decision changed exactly once to `passed`;
- actor `munichdeveloper` and the original label-event timestamp were stored;
- the idempotent decision comment was written;
- all transient gate labels were removed;
- `cleanupPending` was cleared;
- the synthetic issue was closed after evidence capture.

The smoke run also exposed misleading candidate reporting. Commit
`b00e2d5d5a97f7d757858146f5c72f4d87c51326` limits reconciliation output to
open or recoverable gates. A follow-up run reported exactly zero unrelated
runs.

## Audit

Material actions were delivered to the central Immogent process-audit journal
using Envelope v1 with standardized process code, actor, access role, reason,
description, correlation IDs, and evidence. Idempotency keys use the prefix
`harness-run-003:`.

## Remaining gate

After this document and the final verification evidence are part of one exact
delivery head, RUN-003 requires a SHA-specific human merge approval before PR
#6 may be merged into `main`.
