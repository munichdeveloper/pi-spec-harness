# Dedicated audit writer for protected public repositories

Public consumer repositories should not grant the generic GitHub Actions integration an unrestricted ruleset bypass. Any workflow with `contents: write` could otherwise push to the protected default branch.

For append-only process auditing, create a dedicated GitHub App and install it only on the consumer repository. Grant repository metadata read access and contents write access, but no issue, pull-request, administration, workflow, secret, environment, deployment, or organization permissions. Add only that App integration as an always-bypass actor on the default-branch ruleset.

Store the App id as `HARNESS_AUDIT_APP_ID` and the private key as `HARNESS_AUDIT_APP_PRIVATE_KEY` in Actions repository secrets. Never put either value in source, logs, run-state, fixtures, or audit events.

Install the receiver in dedicated-App mode:

```bash
npm run harness -- init \
  --repository owner/repository \
  --run-id bootstrap-001 \
  --requirement REQ-001 \
  --spec SPEC-001 \
  --install-workflows process-audit-receiver \
  --workflow-ref <immutable-release-sha> \
  --audit-writer-auth-mode github-app
```

The reusable workflow mints a short-lived installation token scoped explicitly to the current repository and requests only `contents: write`. It fails before checkout if either credential is absent, if credentials are supplied in generic-token mode, or if dedicated-App mode targets any path other than `docs/process-audit/journal`.

The recorder validates the canonical audit envelope, creates exactly one chronologically named journal file, stages only that file, and retains its existing idempotency and bounded conflict-retry behavior. Existing journal entries and idempotency keys are not migrated or rewritten.

After installation, verify all of the following with synthetic metadata:

1. the default branch rejects a generic `GITHUB_TOKEN` push;
2. the dedicated App records an event below `docs/process-audit/journal`;
3. replaying the same idempotency key produces no second file;
4. missing App configuration fails closed;
5. a dedicated-App receiver configured with another journal path is rejected before publication.

Rotate the private key immediately if it may have been exposed. Remove the App ruleset bypass before uninstalling the receiver.
