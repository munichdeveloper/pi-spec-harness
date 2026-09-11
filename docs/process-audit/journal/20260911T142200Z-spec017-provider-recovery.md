---
schema_version: 1
occurred_at: "2026-09-11T14:22:00.000Z"
confirmed_at: "2026-09-11T14:22:00.000Z"
process_instance: "PI-MUNICHDEVELOPER-PI-SPEC-HARNESS-SPEC-017"
idempotency_key: "spec017:provider-dispatch-recovery:implementation:v1"
process_code: "AI_IMPLEMENTATION"
actor: "CODEX"
access_role: "GITHUB_PERSONAL_ACCESS_TOKEN"
supporting_access_roles:
  - "CODEX_CHAT_SESSION"
outcome: "SUCCEEDED"
repository: "munichdeveloper/pi-spec-harness"
artifact: "ISSUE-207"
correlation_ids:
  - "ISSUE-207"
  - "SPEC-017"
  - "DSB-ISSUE-25"
  - "DSB-ISSUE-35"
  - "DSB-RUN-34589191548"
evidence:
  - "https://github.com/munichdeveloper/pi-spec-harness/issues/207"
  - "https://github.com/munichdeveloper/dsb-new/actions/runs/34589191548"
  - "https://github.com/munichdeveloper/dsb-new/issues/35"
reason: "Restore automatic progress after a live provider dispatch failed before any coding-agent effect was confirmed."
description: "The requirement-to-spec workflow now accepts only the dedicated COPILOT_ASSIGN_PAT secret for the GitHub Copilot assignment boundary. A cancelled transport is retried with its original dispatch key and immutable tracking issue, while confirmed dispatched, PR-open and merged effects remain duplicate-safe. No credential value is recorded. Local typecheck, lint and 814 tests passed."
---
# Process Audit Journal Entry

<!-- harness:audit-record process_code=AI_IMPLEMENTATION -->

Recorded for the SPEC-017 provider-dispatch recovery implementation.
