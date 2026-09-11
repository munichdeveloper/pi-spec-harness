---
schema_version: 1
occurred_at: "2026-09-11T15:32:00.000Z"
confirmed_at: "2026-09-11T15:32:00.000Z"
process_instance: "PI-MUNICHDEVELOPER-PI-SPEC-HARNESS-SPEC-017"
idempotency_key: "spec017:agent-pr-issue-binding:implementation:v1"
process_code: "PR_BIND"
actor: "CODEX"
access_role: "GITHUB_PERSONAL_ACCESS_TOKEN"
supporting_access_roles:
  - "CODEX_CHAT_SESSION"
outcome: "SUCCEEDED"
repository: "munichdeveloper/pi-spec-harness"
artifact: "ISSUE-213"
correlation_ids:
  - "ISSUE-213"
  - "SPEC-017"
  - "DSB-ISSUE-40"
  - "DSB-PR-41"
evidence:
  - "https://github.com/munichdeveloper/dsb-new/pull/41"
reason: "Live polling showed that GitHub Copilot retained the closing issue reference but omitted the opaque dispatch key from its generated PR body."
description: "PR discovery now falls back to a unique GitHub closing reference for the already persisted dispatch issue after exact branch and dispatch-marker matching. Generic numeric mentions are rejected and ambiguous closing references fail closed. No agent dispatch was repeated."
---
# Process Audit Journal Entry

<!-- harness:audit-record process_code=PR_BIND -->

Recorded for the SPEC-017 provider-normalized PR binding iteration.
