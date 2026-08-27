let input = '';
for await (const chunk of process.stdin) input += chunk;
const task = JSON.parse(input);
if (task.operation === 'availability') {
  process.stdout.write(JSON.stringify({ available: true, synthetic: true }));
} else if (task.kind === 'spike') {
  process.stdout.write(JSON.stringify({ source: 'synthetic-coordinate-fixture', latitude: 48.137, longitude: 11.575 }));
} else if (task.kind === 'implementation') {
  // Deliberately deterministic, not a substitute for a real coding-agent test.
  process.stdout.write(JSON.stringify({ synthetic: true, implementationResult: [2, 3, 5].reduce((a, b) => a + b, 0) }));
} else {
  throw new Error('Unsupported synthetic task');
}
