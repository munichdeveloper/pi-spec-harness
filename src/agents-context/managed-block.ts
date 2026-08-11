export const AGENTS_MD_PATH = "AGENTS.md";

export const MANAGED_BLOCK_BEGIN = "<!-- BEGIN pi-spec-harness managed context v1 -->";
export const MANAGED_BLOCK_END = "<!-- END pi-spec-harness managed context v1 -->";

export interface RenderHarnessContextBlockOptions {
  repository: string;
}

/**
 * Render the full, versioned managed context block (including both
 * markers) that gets inserted into (or used to create) a target
 * repository's AGENTS.md. SPEC-008 technical decision 5/6: content is
 * German-language, project-agnostic aside from an optional repository
 * link, and documents the tracking-issue protocol and label vocabulary.
 */
export function renderHarnessContextBlock(options: RenderHarnessContextBlockOptions): string {
  const { repository } = options;
  return `${MANAGED_BLOCK_BEGIN}
## Harness-Kontext (verwaltet von pi-spec-harness)

Dieses Repository${repository ? ` (${repository})` : ""} wird teilweise von [pi-spec-harness](https://github.com/munichdeveloper/pi-spec-harness)
orchestriert. Der Harness ändert keinen Produktcode selbst; er
kontrolliert und beobachtet, wie ein Agent zwischen Spec, Issue, PR und
Merge bewegt wird.

**Bevor du an einem Issue eigenständig arbeitest:** Prüfe zuerst, ob
bereits ein offenes Tracking-Issue (Titel \`[Harness Run] <run-id>\`,
Label \`harness:run\`) existiert, das auf dieses Issue verweist. Falls
ja, enthält dessen Body den kanonischen, aktuellen Fortschrittsstand
(Phase, offene Gates, bisherige Entscheidungen) — lies ihn, bevor du
von vorne beginnst oder rätst, was bereits erledigt ist.

**Label-Vokabular:**

| Label | Bedeutung |
|---|---|
| \`ai:allowed\` | Issue darf von einem Agenten selbstständig bearbeitet werden |
| \`status:ready\` | Issue ist fachlich/technisch bereit zur Bearbeitung |
| \`status:needs-human\` | Ein Mensch muss entscheiden, bevor es weitergeht |
| \`harness:run\` | Markiert das persistente Tracking-Issue eines Runs |
| \`harness:implementation\` | Markiert ein vom Harness erzeugtes Implementierungs-Issue |
| \`harness:gate-approved\` / \`harness:gate-rejected\` | Menschliche Entscheidung auf einem offenen Gate |

Ausführliche Dokumentation zum Protokoll: \`docs/human-gates.md\` und
\`docs/event-driven-workflow.md\` im Harness-Repository.

Dieser Block wird von \`harness init --install-agents-context\`
verwaltet. Änderungen innerhalb der Marker werden bei der nächsten
Installation überschrieben; projektspezifische Regeln gehören
außerhalb dieses Blocks.
${MANAGED_BLOCK_END}`;
}

export type ManagedBlockDecision = "create" | "noop" | "update-managed" | "insert-appended" | "conflict";

export interface UpsertManagedBlockResult {
  content: string;
  decision: ManagedBlockDecision;
}

/**
 * SPEC-008 technical decision 2: the 5-way decision for merging a managed
 * block into a (possibly nonexistent, possibly foreign) AGENTS.md.
 */
export function upsertManagedBlock(existingContent: string | undefined, blockContent: string): UpsertManagedBlockResult {
  if (existingContent === undefined) {
    return { content: blockContent, decision: "create" };
  }

  const beginIndex = existingContent.indexOf(MANAGED_BLOCK_BEGIN);
  const endIndex = existingContent.indexOf(MANAGED_BLOCK_END);
  const hasBegin = beginIndex !== -1;
  const hasEnd = endIndex !== -1;

  if (hasBegin && hasEnd) {
    if (endIndex < beginIndex) {
      // Markers present but out of order: treat as damaged/conflicting.
      return { content: existingContent, decision: "conflict" };
    }
    const before = existingContent.slice(0, beginIndex);
    const after = existingContent.slice(endIndex + MANAGED_BLOCK_END.length);
    const updated = `${before}${blockContent}${after}`;
    if (updated === existingContent) {
      return { content: existingContent, decision: "noop" };
    }
    return { content: updated, decision: "update-managed" };
  }

  if (!hasBegin && !hasEnd) {
    const separator = existingContent.length > 0 && !existingContent.endsWith("\n\n")
      ? existingContent.endsWith("\n")
        ? "\n"
        : "\n\n"
      : "";
    const updated = `${existingContent}${separator}${blockContent}`;
    return { content: updated, decision: "insert-appended" };
  }

  // Exactly one of the two markers is present: damaged state.
  return { content: existingContent, decision: "conflict" };
}
