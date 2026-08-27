---
id: REQ-016
type: requirement
title: Autonomous handoff from approved spec to executable work
status: approved
owner: product
---

# REQ-016

User authorization: implement the milestone requested on 2026-08-27.
Tracking: https://github.com/munichdeveloper/pi-spec-harness/issues/119

Business approval must not be confused with implementation readiness. The
Harness must own the next action after creating an issue, including when an
existing issue was created by another entry point.

## Acceptance criteria

- AC-01: An approved spec produces or reconciles one canonical issue/run
  binding. Retries do not create duplicate issues, runs or assignments.
- AC-02: Explicit structured blockers distinguish implementation prerequisites
  from deployment prerequisites and deferred questions. Unclassified legacy
  specs require classification; absence of metadata is not proof of readiness.
- AC-03: Technical prerequisites become bounded spike work with an owner,
  question, acceptance criteria, execution budget and evidence requirements.
- AC-04: Closing a spike issue does not resolve a blocker. Trusted verification
  must cover the exact spec revision, blocker and every acceptance criterion.
- AC-05: Successful technical clarification resumes the same run without
  asking for the same business approval again. Scope, privacy or cost changes
  require an explicit decision on the existing run.
- AC-06: Only configured, authorized and currently available executors may run.
  Quota exhaustion blocks that executor; no implicit provider or paid fallback.
- AC-07: State, labels and dispatch are reconciled after crashes and duplicate
  events. State and audit evidence remain durable and attributable.
- AC-08: Synthetic E2E proves approved spec -> blocked issue -> verified spike
  -> implementation assignment without chat intervention, plus failure cases.

## Boundaries

No Immogent product planning, external-provider activation, real mail/data,
production changes or new spending. Copilot is unavailable until its quota is
actually restored, not merely until a date is reached. A capability smoke is
not authorization to execute product work with that provider.

The earlier v0.3.0 blanket merge authorization is not extended by this document.
