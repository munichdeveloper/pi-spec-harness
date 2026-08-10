---
id: SPEC-008
type: software-spec
title: Verwalteter Markdown-Kontextblock in AGENTS.md des Zielrepositories
status: approved
owner: engineering
risk: low
requirements:
  - REQ-008
implementation_assignee: "@github-copilot"
created: 2026-08-07
updated: 2026-08-07
---

# SPEC-008: Verwalteter Markdown-Kontextblock in AGENTS.md des Zielrepositories

## Zusammenfassung

Ein neues, von den Workflow-Vorlagen aus SPEC-006 unabhängiges Modul
verwaltet einen abgegrenzten Block innerhalb der `AGENTS.md` des
Zielrepositories. Anders als bei Workflow-Dateien (ganze Datei ist
entweder vollständig verwaltet oder unverändert) wird hier nur ein
markierter Ausschnitt einer potenziell größeren, teils
Repository-eigenen Datei verwaltet. `harness init
--install-agents-context` legt die Datei bei Bedarf an bzw.
aktualisiert ausschließlich den markierten Bereich.

## Technische Entscheidungen

1. Neues Modul `src/agents-context/managed-block.ts` mit:
   - `AGENTS_MD_PATH = "AGENTS.md"`
   - `MANAGED_BLOCK_BEGIN = "<!-- BEGIN pi-spec-harness managed context v1 -->"`
   - `MANAGED_BLOCK_END = "<!-- END pi-spec-harness managed context v1 -->"`
   - `renderHarnessContextBlock(options: { repository: string }): string`
     liefert den vollständigen Blockinhalt inklusive beider Marker.
2. Neue Funktion `upsertManagedBlock(existingContent: string | undefined,
   blockContent: string): { content: string; decision: "create" |
   "noop" | "update-managed" | "insert-appended" | "conflict" }`:
   - `existingContent === undefined` → `create`: neue Datei mit
     ausschließlich dem Block.
   - Datei enthält beide Marker → Bereich zwischen (und inklusive) den
     Markern wird ersetzt; Ergebnis unverändert → `noop`, sonst
     `update-managed`.
   - Datei enthält keinen der beiden Marker → Block wird ans Dateiende
     angehängt (getrennt durch eine Leerzeile), bestehender Inhalt bleibt
     unverändert → `insert-appended`.
   - Datei enthält genau einen der beiden Marker (beschädigter Zustand)
     → `conflict`, kein Schreibzugriff.
3. `cmdInit` in `src/cli.ts` erhält die Option
   `--install-agents-context` (boolean); bei Aktivierung wird
   `upsertManagedBlock()` aufgerufen und das Ergebnis über die bestehende
   Contents-API-Schreibfunktion (`updateFileOnBranch`, analog zu den
   Workflow-Vorlagen) angewendet, außer bei `noop` (kein API-Aufruf) oder
   `conflict` (kein API-Aufruf, sichtbare Meldung im CLI-Ergebnis).
4. `--install-agents-context` ist unabhängig von `--install-workflows`
   und `--install-bug-workflow` aufrufbar und kombinierbar; keine der
   Optionen setzt eine andere voraus.
5. Blockinhalt (deutschsprachig, konsistent mit bestehender
   Harness-Dokumentation):

   ```markdown
   <!-- BEGIN pi-spec-harness managed context v1 -->
   ## Harness-Kontext (verwaltet von pi-spec-harness)

   Dieses Repository wird teilweise von [pi-spec-harness](https://github.com/munichdeveloper/pi-spec-harness)
   orchestriert. Der Harness ändert keinen Produktcode selbst; er
   kontrolliert und beobachtet, wie ein Agent zwischen Spec, Issue, PR und
   Merge bewegt wird.

   **Bevor du an einem Issue eigenständig arbeitest:** Prüfe zuerst, ob
   bereits ein offenes Tracking-Issue (Titel `[Harness Run] <run-id>`,
   Label `harness:run`) existiert, das auf dieses Issue verweist. Falls
   ja, enthält dessen Body den kanonischen, aktuellen Fortschrittsstand
   (Phase, offene Gates, bisherige Entscheidungen) — lies ihn, bevor du
   von vorne beginnst oder rätst, was bereits erledigt ist.

   **Label-Vokabular:**

   | Label | Bedeutung |
   |---|---|
   | `ai:allowed` | Issue darf von einem Agenten selbstständig bearbeitet werden |
   | `status:ready` | Issue ist fachlich/technisch bereit zur Bearbeitung |
   | `status:needs-human` | Ein Mensch muss entscheiden, bevor es weitergeht |
   | `harness:run` | Markiert das persistente Tracking-Issue eines Runs |
   | `harness:implementation` | Markiert ein vom Harness erzeugtes Implementierungs-Issue |
   | `harness:gate-approved` / `harness:gate-rejected` | Menschliche Entscheidung auf einem offenen Gate |

   Ausführliche Dokumentation zum Protokoll: `docs/human-gates.md` und
   `docs/event-driven-workflow.md` im Harness-Repository.

   Dieser Block wird von `harness init --install-agents-context`
   verwaltet. Änderungen innerhalb der Marker werden bei der nächsten
   Installation überschrieben; projektspezifische Regeln gehören
   außerhalb dieses Blocks.
   <!-- END pi-spec-harness managed context v1 -->
   ```

6. `{ repository }` wird nur für einen optionalen Link/Kontext im Block
   verwendet; der Blockinhalt bleibt ansonsten projektunabhängig
   generisch (keine produktspezifischen Aussagen).

## Technische Akzeptanzkriterien

- TAC-01: `upsertManagedBlock(undefined, block)` liefert `decision:
  "create"` und `content` bestehend ausschließlich aus dem Block.
- TAC-02: Für eine Fixture, die Immogents tatsächlicher heutiger
  `AGENTS.md` entspricht (ohne Marker), liefert `upsertManagedBlock`
  `decision: "insert-appended"`; alle fünf bestehenden Abschnitte
  (Quellen der Wahrheit, Vor jeder Implementierung, Implementierung,
  Verifikation, Definition of Done) sind im Ergebnis byteidentisch zum
  Original enthalten, der Block erscheint zusätzlich am Dateiende.
- TAC-03: Eine Fixture mit bereits vorhandenem, veraltetem Blockinhalt
  (beide Marker vorhanden, Text zwischen ihnen weicht ab) liefert
  `decision: "update-managed"`; Inhalt außerhalb der Marker bleibt
  byteidentisch.
- TAC-04: Eine Fixture mit identischem, bereits aktuellem Blockinhalt
  liefert `decision: "noop"`.
- TAC-05: Eine Fixture mit nur einem der beiden Marker liefert
  `decision: "conflict"`; die Funktion nimmt keine Veränderung vor.
- TAC-06: `harness init --install-agents-context` löst bei `noop` und
  `conflict` keinen Contents-API-Schreibaufruf aus, bei `create`,
  `update-managed` und `insert-appended` genau einen.
- TAC-07: Zwei aufeinanderfolgende Aufrufe mit identischen Parametern
  ergeben beim zweiten Aufruf `noop`.
- TAC-08: `--install-agents-context` und `--install-workflows` sind in
  einem einzigen `harness init`-Aufruf kombinierbar; beide Effekte treten
  unabhängig voneinander ein.
- TAC-09: Der gerenderte Block enthält nachweislich alle in REQ-008/AC-06
  geforderten Mindestinhalte (Textmuster-Test auf Tracking-Issue-Hinweis,
  Label-Tabelle, Dokumentations-Link).

## Verifikation

- `npm run check`,
- Fixture-Test mit der tatsächlichen, heutigen Immogent-`AGENTS.md` als
  Eingabe (eingefroren im Testverzeichnis),
- Contract-Tests für alle fünf `upsertManagedBlock()`-Ausgänge (`create`,
  `noop`, `update-managed`, `insert-appended`, `conflict`),
- Idempotenz-Test (zweiter Aufruf ergibt `noop`),
- Kombinations-Test `--install-agents-context` zusammen mit
  `--install-workflows`.

## Rollback

Der Block ist additiv und eigenständig entfernbar: Löschen des Bereichs
zwischen (und inklusive) beiden Markern deaktiviert die Verwaltung für
diese Datei. Wird nur der Blockinhalt, nicht aber die Marker entfernt,
erkennt ein erneuter Install-Aufruf dies als `conflict` und schreibt
nichts — das verhindert ein stillschweigendes Duplizieren von
Harness-Text. Ein vollständiges Entfernen von Datei und Markern führt bei
erneutem Aufruf zu `create` einer neuen, ausschließlich harness-verwalteten
Datei.

## Offene Fragen

Migration zwischen künftigen Blockversionen (z. B. `v1` → `v2` mit
geänderten Markern) ist in dieser Spec nicht gelöst. Ein pragmatischer
erster Ansatz wäre, dass `upsertManagedBlock` zusätzlich nach älteren
bekannten Marker-Mustern sucht und diese als `update-managed` statt
`conflict` behandelt — das wird zurückgestellt, bis tatsächlich eine
zweite Blockversion ansteht.
