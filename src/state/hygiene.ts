/**
 * Data hygiene guard, run before every persistence of run-state.
 * Blocks secrets, tokens, and other data that must never end up in
 * versioned or long-lived local state.
 */

const FORBIDDEN_KEY_PATTERN =
  /(token|secret|password|passwd|cookie|api[_-]?key|authorization|bearer|private[_-]?key)/i;

const KNOWN_TOKEN_PATTERNS: RegExp[] = [
  /gh[oprsu]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /sk-[A-Za-z0-9]{20,}/, // OpenAI/Anthropic-style secret keys
  /xox[baprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /AKIA[0-9A-Z]{16}/, // AWS access key id
];

export interface HygieneViolation {
  path: string;
  reason: string;
}

export function checkHygiene(value: unknown, path = "$"): HygieneViolation[] {
  const violations: HygieneViolation[] = [];
  walk(value, path, violations);
  return violations;
}

function walk(value: unknown, path: string, violations: HygieneViolation[]): void {
  if (value === null || value === undefined) return;

  if (typeof value === "string") {
    for (const pattern of KNOWN_TOKEN_PATTERNS) {
      if (pattern.test(value)) {
        violations.push({ path, reason: `value matches known token pattern ${pattern}` });
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, violations));
    return;
  }

  if (typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const childPath = `${path}.${key}`;
      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        violations.push({ path: childPath, reason: `field name '${key}' looks like a credential field` });
        continue;
      }
      walk(val, childPath, violations);
    }
  }
}

export function assertHygiene(value: unknown): void {
  const violations = checkHygiene(value);
  if (violations.length > 0) {
    const details = violations.map((v) => `  - ${v.path}: ${v.reason}`).join("\n");
    throw new Error(`Refusing to persist state: hygiene violation(s) found:\n${details}`);
  }
}
