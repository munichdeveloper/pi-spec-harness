import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// Emit configuration only. The trusted workflow materializes this output in its
// ephemeral checkout. Never activate a provider or modify consumer repositories.
const repository = process.env.GITHUB_REPOSITORY;
if (repository !== 'munichdeveloper/pi-spec-harness') throw new Error('Synthetic activation is restricted to the harness repository');
const scenario = process.env.HARNESS_READINESS_SYNTHETIC_SCENARIO || 'success';
if (!['success', 'quota-unavailable', 'invalid-coordinates', 'incomplete-result', 'agent-failure'].includes(scenario)) {
  throw new Error('Unknown synthetic scenario');
}
const workflowId = Number(process.env.HARNESS_READINESS_EXECUTOR_WORKFLOW_ID);
const runtimeBranch = process.env.HARNESS_READINESS_RUNTIME_BRANCH;
const sourceBranch = process.env.HARNESS_READINESS_SOURCE_BRANCH || 'main';
if (!Number.isSafeInteger(workflowId) || workflowId <= 0 || !runtimeBranch || !/^[a-zA-Z0-9_/-]+$/.test(runtimeBranch)) {
  throw new Error('Missing explicit synthetic workflow identity/runtime branch');
}
const specPath = 'docs/testing/readiness/SPEC-900001.md';
const content = readFileSync(specPath);
const specRevision = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
const command = name => ({ executable: process.execPath, args: [resolve('scripts', name)], cwd: process.cwd(), timeoutMs: 10000,
  env: { HARNESS_READINESS_SYNTHETIC_SCENARIO: scenario } });
const policy = { id: 'synthetic-local', authorized: true, available: true, capabilities: ['spike', 'implementation'], maxTaskCost: 0 };
const contract = { schemaVersion: 1, specRevision, blockers: [{ id: 'synthetic-coordinates', stage: 'implementation', kind: 'technical',
  owner: 'synthetic-verifier', question: 'Does the deterministic fixture contain the expected coordinate sample?',
  criteria: ['Exact synthetic coordinate sample verified independently'], maxAttempts: 2 }] };
const availability = command('readiness-synthetic-agent.mjs');
const audit = { directory: 'docs/process-audit/journal', branch: 'main' };
process.stdout.write(JSON.stringify({
  executor: { schemaVersion: 1, repository, costCeiling: 0, policy, contract, availability,
    agent: command('readiness-synthetic-agent.mjs'), verifier: command('readiness-synthetic-verifier.mjs'), audit },
  reconcile: { schemaVersion: 1, repository, branch: sourceBranch, specPath, costCeiling: 0, contract, audit,
    executors: [{ policy, availability, workflow: { repository, branch: runtimeBranch, workflowId,
      workflowPath: '.github/workflows/readiness-executor.yml', workflowRevision: '$runtime',
      allowedActorIds: [41898282] } }] },
}));
