export function classifyIssueIntake(
  titleInput: unknown,
  bodyInput?: unknown,
): { kind: "spec" | "bug" | "spike" | "requirement" | "incomplete"; label: string };
