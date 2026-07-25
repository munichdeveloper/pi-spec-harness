/**
 * Parse YAML frontmatter from a Markdown file.
 * Expects format:
 * ```
 * ---
 * key: value
 * ...
 * ---
 * # Rest of content
 * ```
 */
export function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) {
    throw new Error("No frontmatter found in file");
  }

  const fm: Record<string, unknown> = {};
  const lines = match[1].split("\n");

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.substring(0, colonIdx).trim();
    const valueStr = line.substring(colonIdx + 1).trim();

    // Parse common types
    if (valueStr.startsWith('"') && valueStr.endsWith('"')) {
      fm[key] = valueStr.slice(1, -1);
    } else if (valueStr.startsWith("'") && valueStr.endsWith("'")) {
      fm[key] = valueStr.slice(1, -1);
    } else if (valueStr === "true") {
      fm[key] = true;
    } else if (valueStr === "false") {
      fm[key] = false;
    } else if (valueStr === "null") {
      fm[key] = null;
    } else if (/^\d+$/.test(valueStr)) {
      fm[key] = Number(valueStr);
    } else if (valueStr.startsWith("[")) {
      // Simple array parsing for items like [REQ-001]
      try {
        fm[key] = JSON.parse(valueStr);
      } catch {
        fm[key] = valueStr;
      }
    } else {
      fm[key] = valueStr;
    }
  }

  return fm;
}

/**
 * Fetch a spec file from GitHub and extract implementation_assignee.
 * Defaults to "@github-copilot" if not specified.
 */
export async function getSpecAssignee(repository: string, specFileName: string): Promise<string> {
  // Use GitHub REST API to fetch the file content
  const url = `https://api.github.com/repos/${repository}/contents/docs/30-specifications/${specFileName}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch spec file: ${response.status} ${response.statusText}. ` +
      `(Note: This may mean the spec branch hasn't been pushed yet, ` +
      `or the file path doesn't match the convention.)`
    );
  }

  const data = (await response.json()) as { content: string };
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  const fm = parseFrontmatter(content);
  const assignee = (fm.implementation_assignee as string) || "@github-copilot";
  return assignee;
}
