import assert from 'node:assert/strict';
import { github } from '../dist/github/gh.js';
import { parseStateFromBody } from '../dist/state/issue-store.js';
import { readVerifiedReadinessSpikeResult } from '../dist/spec/readiness-evidence.js';

// Read-only hosted API proof against an explicitly known synthetic fixture.
// Never mutate canonical state, upload replacement evidence, or run an agent.
const repository = 'munichdeveloper/pi-spec-harness';
const policy = {
  repository, workflowId: 344477441,
  workflowPath: '.github/workflows/readiness-executor.yml',
  workflowRevision: '11ea45c230d78b3e368c339aead70f10db190696',
  allowedActorIds: [41898282],
};
const issue = await github.viewIssue(repository, 154);
const state = parseStateFromBody(issue.body);
assert.equal(state.spec, 'SPEC-900010');
const work = state.readiness?.work.find(item => item.kind === 'spike');
assert.equal(work?.receipt, 'github-actions:33211011952');
assert.equal(work?.execution?.status, 'completed');
const accepted = await readVerifiedReadinessSpikeResult(work, policy);
assert.equal(accepted?.verdict, 'passed');
// Simulate a newer expected spec identity only in memory. The real, signed-in
// GitHub producer and stored artifact remain unchanged and are read again.
const newer = { ...work, revision: work.revision === 'f'.repeat(40) ? 'e'.repeat(40) : 'f'.repeat(40) };
await assert.rejects(
  readVerifiedReadinessSpikeResult(newer, policy),
  /Invalid or incorrectly bound readiness result/,
);
assert.equal((await github.viewIssue(repository, 154)).body, issue.body);
process.stdout.write(JSON.stringify({ schemaVersion: 1, command: 'verify-readiness-stale-evidence',
  result: { repository, runIssue: 154, producerRun: 33211011952,
    currentEvidenceAccepted: true, staleEvidenceRejected: true, canonicalStateUnchanged: true },
  nextAction: 'No mutation performed; scheduler and lifecycle proofs remain separate.' }, null, 2) + '\n');
