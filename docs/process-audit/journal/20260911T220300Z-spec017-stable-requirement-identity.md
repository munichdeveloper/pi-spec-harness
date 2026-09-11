---
schema_version: 1
occurred_at: "2026-09-11T22:03:00.000Z"
confirmed_at: "2026-09-11T22:03:00.000Z"
process_instance: "PI-MUNICHDEVELOPER-PI-SPEC-HARNESS-SPEC-017"
idempotency_key: "spec017:stable-requirement-identity:implementation:v1"
process_code: "IMPLEMENTATION_UPDATE"
actor: "CODEX"
access_role: "GITHUB_PERSONAL_ACCESS_TOKEN"
supporting_access_roles:
  - "CODEX_CHAT_SESSION"
outcome: "SUCCEEDED"
repository: "munichdeveloper/pi-spec-harness"
artifact: "ISSUE-218"
correlation_ids:
  - "ISSUE-218"
  - "DSB-ISSUE-40"
  - "DSB-PR-41"
  - "DSB-PR-42"
evidence:
  - "https://github.com/munichdeveloper/pi-spec-harness/issues/218"
  - "https://github.com/munichdeveloper/dsb-new/pull/41"
  - "https://github.com/munichdeveloper/dsb-new/pull/42"
reason: "An unrelated Harness pin merge changed the repository HEAD and would have generated a second dispatch key for unchanged REQ-025."
description: "Requirement dispatch identity is now derived from the requirement Git blob. During identity migration, a unique active PR linked to an earlier dispatch record is adopted into the new durable record instead of sending another agent assignment. Multiple active effects fail closed. The dsb-new workflow remains disabled until reviewed code and its immutable runtime pin are installed."
---
# Process Audit Journal Entry

<!-- harness:audit-record process_code=IMPLEMENTATION_UPDATE -->

Recorded for stable requirement source identity and active-effect adoption.
