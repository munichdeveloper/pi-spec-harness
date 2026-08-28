let input = '';
for await (const chunk of process.stdin) input += chunk;
const task = JSON.parse(input);
const candidate = task.candidate;
const passed = candidate?.source === 'synthetic-coordinate-fixture'
  && candidate.latitude === 48.137 && candidate.longitude === 11.575;
process.stdout.write(JSON.stringify({
  blockerId: task.blocker.id, specRevision: task.specRevision,
  verdict: passed ? 'passed' : 'failed',
  verifiedCriteria: passed ? ['Exact synthetic coordinate sample verified independently'] : [],
  references: ['https://github.com/munichdeveloper/pi-spec-harness/blob/bc453c31bb4808fb63ba9b39fa3a3afe2085f8e0/scripts/readiness-synthetic-agent.mjs'], changes: [],
}));
