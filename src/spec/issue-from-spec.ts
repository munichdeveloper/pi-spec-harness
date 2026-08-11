/**
 * SPEC-007: Build an implementation-issue title/body from an approved
 * software spec's frontmatter and content. This is the single, shared
 * implementation used both by `harness issue-create --from-spec-path`
 * (existing CLI path, REQ-003) and by the reactive `spec-to-issue.yml`
 * pipeline, so title/body format is maintained in exactly one place.
 *
 * Conceptually ports what Immogent's `scripts/create_issue_from_spec.py`
 * did locally: read frontmatter, require `status: approved`, format the
 * title as `<SPEC-ID>: <Titel>`, and build a body with a requirements
 * list, an optional "Zerlegung in Issues" section (verbatim from the spec
 * body if present), and a Definition of Ready checklist.
 */

export class IssueFromSpecError extends Error {}

export interface SpecFrontmatterForIssue {
  id: string;
  title: string;
  status: string;
  requirements: string[];
}

export interface BuildIssueFromSpecOptions {
  /** Repo-relative path of the spec file, embedded in the issue body for traceability. */
  specPath?: string;
}

export interface BuiltIssueFromSpec {
  title: string;
  body: string;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Minimal, purpose-built frontmatter parser that (unlike the generic
 * `parseFrontmatter()` in `src/spec/spec-parser.ts`) correctly handles the
 * multi-line YAML list syntax used for `requirements:` in real specs, e.g.:
 *
 * ```yaml
 * requirements:
 *   - REQ-006
 * ```
 */
export function parseSpecFrontmatterForIssue(specContent: string): SpecFrontmatterForIssue {
  const match = specContent.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
  if (!match) {
    throw new IssueFromSpecError("spec content has no frontmatter block");
  }

  const fm: Record<string, unknown> = {};
  let currentListKey: string | null = null;

  for (const rawLine of match[1].split(/\r?\n/)) {
    const listItemMatch = rawLine.match(/^\s+-\s*(.+)$/);
    if (listItemMatch && currentListKey) {
      const arr = (fm[currentListKey] as string[] | undefined) ?? [];
      arr.push(stripQuotes(listItemMatch[1]));
      fm[currentListKey] = arr;
      continue;
    }

    const colonIdx = rawLine.indexOf(":");
    if (colonIdx === -1) {
      currentListKey = null;
      continue;
    }

    const key = rawLine.slice(0, colonIdx).trim();
    const valueStr = rawLine.slice(colonIdx + 1).trim();

    if (valueStr === "") {
      // Could be the start of a multi-line list; only treated as such if
      // followed by `- item` lines above.
      currentListKey = key;
      continue;
    }

    currentListKey = null;
    if (valueStr.startsWith("[")) {
      try {
        fm[key] = (JSON.parse(valueStr) as unknown[]).map((v) => String(v));
        continue;
      } catch {
        // fall through to scalar handling
      }
    }
    fm[key] = stripQuotes(valueStr);
  }

  return {
    id: typeof fm.id === "string" ? fm.id : "",
    title: typeof fm.title === "string" ? fm.title : "",
    status: typeof fm.status === "string" ? fm.status : "",
    requirements: Array.isArray(fm.requirements) ? (fm.requirements as string[]) : [],
  };
}

/**
 * Extract a top-level `## <heading>` section's body (everything up to the
 * next `## ` heading or end of file), verbatim and trimmed. Returns
 * undefined if the heading is not present or its body is empty.
 */
function extractSection(specContent: string, heading: string): string | undefined {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^##\\s+${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s|$(?![\\s\\S]))`, "m");
  const match = specContent.match(re);
  if (!match) return undefined;
  const body = match[1].trim();
  return body.length > 0 ? body : undefined;
}

/**
 * Build the `{ title, body }` pair for an implementation issue from an
 * approved spec's full Markdown content (frontmatter + body).
 *
 * SPEC-007 TAC-02: throws a typed `IssueFromSpecError` for `status !=
 * approved` or a missing/empty `requirements[]`, without returning any
 * partial result.
 */
export function buildIssueFromSpec(specContent: string, options: BuildIssueFromSpecOptions = {}): BuiltIssueFromSpec {
  const fm = parseSpecFrontmatterForIssue(specContent);

  if (fm.status !== "approved") {
    throw new IssueFromSpecError(
      `spec must have status: approved to create an implementation issue (got '${fm.status || "<missing>"}')`,
    );
  }
  if (!fm.id) {
    throw new IssueFromSpecError("spec frontmatter is missing 'id'");
  }
  if (!fm.title) {
    throw new IssueFromSpecError("spec frontmatter is missing 'title'");
  }
  if (!fm.requirements || fm.requirements.length === 0) {
    throw new IssueFromSpecError("spec frontmatter is missing a non-empty 'requirements' list");
  }

  const title = `${fm.id}: ${fm.title}`;

  const breakdown = extractSection(specContent, "Zerlegung in Issues");

  const bodyParts: string[] = [];
  bodyParts.push(`**Spec:** ${fm.id}${options.specPath ? ` (\`${options.specPath}\`)` : ""}`);
  bodyParts.push(`**Requirement(s):** ${fm.requirements.join(", ")}`);
  bodyParts.push("");
  bodyParts.push("## Requirements");
  for (const requirement of fm.requirements) {
    bodyParts.push(`- ${requirement}`);
  }
  bodyParts.push("");

  if (breakdown) {
    bodyParts.push("## Zerlegung in Issues");
    bodyParts.push(breakdown);
    bodyParts.push("");
  }

  bodyParts.push("## Definition of Ready");
  bodyParts.push("- [ ] Requirement(s) und Spec sind freigegeben (`status: approved`)");
  bodyParts.push("- [ ] Akzeptanzkriterien aus der Spec sind verstanden und werden als Scope dieses Issues betrachtet");
  bodyParts.push("- [ ] Nicht-Ziele/Scope-Grenzen sind bekannt");
  bodyParts.push("- [ ] Kein offenes technisches Risiko ohne zugehöriges Human-Gate");
  bodyParts.push("");

  return { title, body: bodyParts.join("\n") };
}
