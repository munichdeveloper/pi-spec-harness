let input = '';
for await (const chunk of process.stdin) input += chunk;
const task = JSON.parse(input);
const scenario = process.env.HARNESS_READINESS_SYNTHETIC_SCENARIO || 'success';
if (!['success', 'quota-unavailable', 'invalid-coordinates', 'incomplete-result', 'agent-failure'].includes(scenario)) {
  throw new Error('Unknown synthetic scenario');
}
if (task.operation === 'availability') {
  process.stdout.write(JSON.stringify({ available: scenario !== 'quota-unavailable', synthetic: true }));
} else if (scenario === 'quota-unavailable' || scenario === 'agent-failure') {
  throw new Error(`Synthetic execution blocked: ${scenario}`);
} else if (task.kind === 'spike') {
  const candidate = { source: 'synthetic-coordinate-fixture', latitude: 48.137, longitude: 11.575 };
  if (scenario === 'invalid-coordinates') candidate.latitude = 0;
  if (scenario === 'incomplete-result') delete candidate.longitude;
  process.stdout.write(JSON.stringify(candidate));
} else if (task.kind === 'implementation') {
  // Deliberately deterministic, not a substitute for a real coding-agent test.
  process.stdout.write(JSON.stringify({ synthetic: true, implementationResult: [2, 3, 5].reduce((a, b) => a + b, 0) }));
} else {
  throw new Error('Unsupported synthetic task');
}
