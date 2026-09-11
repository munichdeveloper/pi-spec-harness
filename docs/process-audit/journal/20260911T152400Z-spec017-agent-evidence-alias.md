---
schema_version: 1
occurred_at: "2026-09-11T15:24:00.000Z"
confirmed_at: "2026-09-11T15:24:00.000Z"
process_instance: "PI-MUNICHDEVELOPER-PI-SPEC-HARNESS-SPEC-017"
idempotency_key: "spec017:agent-evidence-alias:implementation:v1"
process_code: "AI_IMPLEMENTATION"
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
  - "DSB-RUN-34615443212"
evidence:
  - "https://github.com/munichdeveloper/pi-spec-harness/issues/213"
  - "https://github.com/munichdeveloper/dsb-new/actions/runs/34615443212"
  - "https://github.com/munichdeveloper/dsb-new/issues/40"
  - "https://github.com/munichdeveloper/dsb-new/pull/41"
reason: "The live provider effect succeeded, but GitHub's issue and pull-request read models normalized the agent identity and requested branch name."
description: "The Harness now maps GitHub's Copilot read alias to the canonical coding-agent identity, skips an already effective assignment, and falls back from exact branch discovery to a unique immutable dispatch-key marker in the pull-request body. Ambiguous marker evidence fails closed. No credential value is recorded."
---
# Process Audit Journal Entry

<!-- harness:audit-record process_code=AI_IMPLEMENTATION -->

Recorded for the SPEC-017 coding-agent evidence normalization correction.
