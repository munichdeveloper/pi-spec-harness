import { pathToFileURL } from "node:url";

export function classifyIssueIntake(titleInput, bodyInput = "") {
  const title = String(titleInput ?? "").toLocaleLowerCase("de-DE");
  const text = `${titleInput ?? ""}\n${bodyInput ?? ""}`.toLocaleLowerCase("de-DE");

  if (/^\s*(\[[^\]]*\]\s*)?spec-\d+(?=[:\s]|$)/u.test(title) || /^\s*software\s+spec(ifikation)?(?=[:\s]|$)/u.test(title)) {
    return { kind: "spec", label: "type:spec" };
  }
  if (/\b(bug|fehler)\b/u.test(text) || text.includes("funktioniert nicht")) {
    return { kind: "bug", label: "type:bug" };
  }
  if (/\bspike\b/u.test(text) || /\buntersuchen\b/u.test(text)) {
    return { kind: "spike", label: "type:spike" };
  }

  const hasAcceptanceSection = /^#{1,6}\s*akzeptanzkriterien\s*$/imu.test(text);
  const hasOutcomeSection = /^#{1,6}\s*(ziel|gewünschte|gewuenschte)(?:\s+[\p{L}\p{N}-]+)*\s*$/imu.test(text);
  if (
    (hasAcceptanceSection && hasOutcomeSection) ||
    /\breq-\d+\b/u.test(text) ||
    /\banforderung\b/u.test(text) ||
    text.includes("ich möchte") ||
    text.includes("ich moechte")
  ) {
    return { kind: "requirement", label: "type:requirement" };
  }
  return { kind: "incomplete", label: "intake:needs-information" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = classifyIssueIntake(process.env.ISSUE_TITLE, process.env.ISSUE_BODY);
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is required");
  const { appendFileSync } = await import("node:fs");
  appendFileSync(output, `kind=${result.kind}\nlabel=${result.label}\n`, "utf8");
}
