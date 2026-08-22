# Regeln für KI-Agenten in diesem Repository

Dieses Repository *implementiert* den Harness. Für die Regeln, wie der
Harness beim Arbeiten an einem Zielrepo (z. B. Immogent) zu benutzen ist,
siehe [`skills/pi-spec-harness/SKILL.md`](skills/pi-spec-harness/SKILL.md).

## Grundsätze

- Jede GitHub-Schreibaktion muss als benannte, auditierbare Funktion in
  `src/github/gh.ts` existieren. Keine generische "führe beliebigen gh-Befehl
  aus"-Eskapiermöglichkeit.
- Human Gates sind ausschließlich über GitHub-Issue-Labels auflösbar
  (`harness:gate-approved` / `harness:gate-rejected`). Kein Code darf eine
  Chat-Antwort oder einen Kommentartext als Freigabe interpretieren.
- Ein Run hat genau **ein** persistentes Tracking-Issue (`harness:run`)
  über seine gesamte Lebensdauer. Gates öffnen niemals ein neues Issue --
  sie setzen transiente Labels auf das bestehende Tracking-Issue und hängen
  einen Kommentar an. Das Issue wird nur beim Erreichen der Phase
  `complete` geschlossen.
- Der Run-State lebt kanonisch im Issue-Body (siehe
  `src/state/issue-store.ts`), nicht in einer Datei, die nur lokal
  existiert -- sonst kann keine GitHub Action ohne laufende Chat-Sitzung
  weiterarbeiten.
- `computeNextAction` in `src/state/state-machine.ts` ist eine reine
  Funktion: kein I/O, kein GitHub-Zugriff. Seiteneffekte (State speichern,
  GitHub ansprechen) gehören in die CLI-Befehle oder das Skill-Protokoll,
  nicht in die State-Machine selbst.
- `saveRunState` prüft vor jedem Schreiben Datenhygiene
  (`src/state/hygiene.ts`). Diese Prüfung darf nicht umgangen werden.
- Neue CLI-Befehle liefern `{ schemaVersion, command, result, nextAction }`.
- Tests für neues Verhalten in `test/` ergänzen; `npm run check` muss grün
  bleiben.
- `issue-create`-Titel müssen die SPEC-ID enthalten (z. B. `SPEC-014: ...`).
  Ziel-Repos können eine eigene Spec→Issue-Automatisierung besitzen, die
  Duplikate ausschließlich über die SPEC-ID im Issue-Titel erkennt (siehe
  `skills/pi-spec-harness/SKILL.md`, Abschnitt "Issue-Gate"). Ohne die
  SPEC-ID im Titel drohen doppelte Issues, wenn eine Spec sowohl über die
  Harness-CLI als auch ohne sie (direkter Merge im Ziel-Repo) bearbeitet
  wird.

## Verantwortungsmodell der Software Factory

Die Verantwortlichkeiten zwischen Produktsteuerung, externer Planung und
Harness-Ausführung werden strikt getrennt:

- Der **Product Owner** trifft fachliche Entscheidungen und erteilt Human-Gate-
  sowie Merge-Freigaben.
- Ein **externer Planungsagent** verantwortet Zielzerlegung, Slice-Definition,
  Requirements/Specs und die Erstellung der zugehörigen GitHub-Issues.
- Der **Harness-Ausführungsagent** arbeitet ausschließlich an bereits
  definierten und freigegebenen Harness-Tickets beziehungsweise aktiven
  Harness-Runs. Er erstellt keine Tickets, definiert keine neuen Slices und
  erweitert den Scope nicht eigenständig.
- **Implementierungs- und Reviewagenten** bearbeiten nur den explizit
  delegierten Scope. Findings führen zurück in den bestehenden Run; sie
  erzeugen nicht stillschweigend einen neuen Slice.

Jede Übergabe muss im kanonischen Run-State und Process Audit sichtbar sein.
Mindestens festzuhalten sind auslösender Akteur, ausführender Akteur,
Zugriffsrolle, Artefakt beziehungsweise gebundene SHA, Begründung, Ergebnis und
der nächste verantwortliche Akteur. Automatische Fortsetzungen nach einer
Freigabe dürfen diese Rollengrenzen nicht aufweichen.

Übergeordnetes Automatisierungsziel: Nach einer menschlichen PR- und
Harness-Gate-Freigabe übernimmt der Harness Merge, Polling, Post-Merge-
Verifikation, Audit-/Dokumentationspersistenz und Run-Fortsetzung vollständig
ereignisgesteuert und idempotent. Nur echte fachliche Entscheidungen oder
nicht automatisch behebbare Blockaden dürfen wieder einen Menschen anfordern.

## Definition of Done für Änderungen an diesem Repo

- `npm run check` (typecheck + lint + test) ist grün.
- Neue Gate- oder State-Übergänge sind mit Unit-Tests abgedeckt.
- README/Docs sind aktualisiert, wenn sich das Protokoll ändert.

<!-- BEGIN pi-spec-harness managed context v1 -->
## Harness-Kontext (verwaltet von pi-spec-harness)

Dieses Repository (munichdeveloper/pi-spec-harness) wird teilweise von [pi-spec-harness](https://github.com/munichdeveloper/pi-spec-harness)
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
