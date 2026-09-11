---
schema_version: 1
occurred_at: "2026-09-11T15:09:00.000Z"
confirmed_at: "2026-09-11T15:09:00.000Z"
process_instance: "PI-MUNICHDEVELOPER-PI-SPEC-HARNESS-SPEC-017"
idempotency_key: "spec017:official-spec-agent-assignment:implementation:v1"
process_code: "AI_IMPLEMENTATION"
actor: "CODEX"
access_role: "GITHUB_PERSONAL_ACCESS_TOKEN"
supporting_access_roles:
  - "CODEX_CHAT_SESSION"
outcome: "SUCCEEDED"
repository: "munichdeveloper/pi-spec-harness"
artifact: "ISSUE-210"
correlation_ids:
  - "ISSUE-210"
  - "SPEC-017"
  - "DSB-ISSUE-38"
  - "DSB-RUN-34614183175"
evidence:
  - "https://github.com/munichdeveloper/pi-spec-harness/issues/210"
  - "https://github.com/munichdeveloper/dsb-new/actions/runs/34614183175"
reason: "The live recovery proved that a normal issue assignee mutation cannot dispatch a GitHub coding agent."
description: "The spec-generation adapter now invokes the official Agent Assignment API with the canonical copilot-swe-agent[bot] identity, explicit target repository and configured default base branch. The dedicated credential remains scoped to that subprocess; subsequent issue-store operations use GITHUB_TOKEN. No secret value is recorded. Local typecheck, lint and 814 tests passed."
---
# Process Audit Journal Entry

<!-- harness:audit-record process_code=AI_IMPLEMENTATION -->

Recorded for the SPEC-017 official coding-agent assignment correction.
