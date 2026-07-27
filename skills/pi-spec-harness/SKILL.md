---
name: pi-spec-harness
description: Use this skill whenever you work on a spec-driven development run for a reference product (e.g. munichdeveloper/Immogent) and need to track run-state, gates, and especially human decisions. Load it before starting implementation work on a GitHub Issue derived from an approved Software Spec, and consult it whenever you are unsure whether something requires human approval.
---

# Pi Spec Harness

Dieser Skill macht dich (Pi) zum Implementierungs- **und** Buchhaltungsagenten
für einen spezifikationsgetriebenen Entwicklungsdurchlauf. Er ersetzt das
alte, rein lesende `spec-driven-agent-harness`-Repository durch eine
Pi-native Variante: du darfst tatsächlich Code schreiben, Branches/PRs
anlegen und GitHub-Issues öffnen -- aber ausschließlich innerhalb der hier
beschriebenen Leitplanken.

## Kernregel: Trennung von Chat und Human Gate

**Menschliche Entscheidungen werden niemals nur im Chat verhandelt.** Sobald
du erkennst, dass eine Entscheidung ansteht (Produktentscheidung, Risiko,
Kosten, Secrets, Merge bei mittlerem/hohem Risiko, Eskalation nach drei
gescheiterten Iterationen, Unklarheit im Requirement), tust du dies:

1. Falls noch kein Run-State existiert: `harness init --repository <repo>
   --run-id <id> --requirement <REQ> --spec <SPEC>` ausführen. Das legt
   (find-or-create, idempotent) ein einziges, dauerhaftes Tracking-Issue
   `[Harness Run] <run-id>` im Zielrepository an -- der komplette Run-State
   lebt fortan in dessen Body. Es gibt bewusst **kein** separates State-File,
   das nur lokal existiert: alles, was eine Entscheidung braucht, muss von
   GitHub aus sichtbar und bedienbar sein, auch für eine GitHub Action ohne
   laufende Chat-Sitzung.
2. Ein Gate registrieren und öffnen:
   ```
   harness gate-open --repository <repo> --run-id <id> --gate-id <kurze-id> \
     --type human --title "<kurzer Titel>" \
     --question "<konkrete Frage>" \
     --context "<Zeile 1>" --context "<Zeile 2>"
   ```
   Das setzt Labels `harness:gate-open` + `status:needs-human` auf das
   bestehende Tracking-Issue und hängt Frage/Kontext als Kommentar an --
   es wird **kein neues Issue** erzeugt.
3. Im Chat nur **kurz** auf das Tracking-Issue verweisen (Link), nicht die
   Entscheidung selbst dort ausdiskutieren.
4. Arbeit an diesem Run stoppen, bis das Gate aufgelöst ist (siehe unten).
   An anderen, unabhängigen Runs darfst du weiterarbeiten.

Ein Mensch löst das Gate ausschließlich durch Setzen des Labels
`harness:gate-approved` oder `harness:gate-rejected` auf dem Tracking-Issue.
Kommentare allein zählen nicht als Entscheidung. `harness resume` (von dir,
mir, oder einer GitHub Action) übernimmt die Entscheidung, entfernt die
transienten Labels und hält das Issue offen, bis der ganze Run `complete`
ist -- beim nächsten Gate desselben Runs wird dasselbe Issue wiederverwendet.

## Werkzeuge

Das Harness-CLI liegt in diesem Repository (`pi-spec-harness`) unter
`src/cli.ts`, ausgeführt über `npm run harness -- <command>` oder gebaut via
`npm run build` + `node dist/cli.js <command>`. Jeder Befehl gibt
`{ schemaVersion, command, result, nextAction }` als JSON zurück -- lies
immer `nextAction`, um zu wissen, was als Nächstes zu tun ist.

Alle Befehle akzeptieren entweder `--state <pfad>` (lokales Datei-Backend,
nur für Tests/Smoke-Runs sinnvoll) oder `--repository <repo> --run-id <id>`
(GitHub-Issue-Backend, Standardfall für echte Runs).

Wichtige Befehle:

- `init` -- Run anlegen (idempotent).
- `status` -- aktuellen State + nächste Aktion anzeigen.
- `resume` -- nächste Aktion neu berechnen; pollt automatisch ein offenes
  Human-Gate-Issue auf eine Entscheidung.
- `gate-open --type <spec|issue|runtime|review|human|merge>` -- Gate
  registrieren; bei `human` zusätzlich GitHub-Issue anlegen.
- `gate-resolve` -- nicht-menschliche Gates (z. B. `spec`, `runtime`, `merge`)
  manuell mit Ergebnis + Evidence auflösen, nachdem du die Prüfung selbst
  durchgeführt hast (Tests, CI-Status, Review-Threads).
- `issue-create` -- Implementation-Issue erstellen, automatisch assignen basierend
  auf der SPEC's `implementation_assignee`-Feld (Standard: `@github-copilot`).
  Öffnet automatisch das `issue-ready`-Gate. Mit `--assignee <username>` override.
- `phase` -- Phase explizit setzen (`requirement` bis `complete`).
- `iteration-start` / `iteration-finish` -- automatische
  Korrekturiterationen zählen; nach `maxAutomaticIterations` (Default 3)
  fehlgeschlagenen Iterationen erzwingt `computeNextAction` eine Eskalation.

## Ablauf für ein Slice (Requirement → Merge)

1. **Voraussetzung prüfen:** Requirement und Spec im Ziel-Repo (`docs/`)
   müssen `status: approved` sein. Falls nicht, öffne ein Human-Gate
   (`gate-id: requirement-approval` bzw. `spec-approval`) statt zu raten.
2. **Run initialisieren:** `harness init --run-id ... --repository ... \
   --requirement REQ-XXX --spec SPEC-XXX`.
3. **Issue-Gate:** Implementierungs-Issue erstellen. Die SPEC-Datei sollte ein
   Feld `implementation_assignee` im Frontmatter haben (Standard:
   `@github-copilot`). Nutze:
   ```
   harness issue-create --repository owner/repo --run-id <run-id> \
     --title "<Kurzer Titel>" --body "<Markdown-Beschreibung>" \
     --labels "status:ready" "ai:allowed" --assignee <override-optional>
   ```
   Der Harness liest `implementation_assignee` aus der SPEC, erstellt das
   Issue, assignt es automatisch und öffnet das `issue-ready`-Gate.
4. **Implementierung:** eigener Branch, kleiner Scope, Tests mitliefern.
   Nutze deine normalen Tools (`bash`, `read`, `edit`, `write`) direkt im
   Ziel-Repo-Checkout -- das Harness bucht nur mit, es tut die Arbeit nicht
   für dich.
5. **Verifikation:** Linting/Typprüfung/Tests/Build laufen lassen. Ergebnis
   mit `gate-resolve --gate-id verification --result passed|failed
   --evidence <Pfad-oder-Log>` festhalten.
6. **Iteration bei Fehlern:** `iteration-start` vor jedem Korrekturversuch,
   `iteration-finish --result failed --findings "..."` danach. Nach dem
   dritten Fehlschlag öffnet die Logik automatisch eine Eskalation -- du
   musst dann ein Human-Gate öffnen (`gate-id: needs-human-escalation`),
   nicht selbst einen vierten Versuch starten.
7. **PR & Dokumentation:** PR im Ziel-Repo öffnen, Dokumentation im selben PR
   aktualisieren, PR-Beschreibung verlinkt Requirement/Spec/Issue.
8. **Merge-Gate:** Bei `risk: medium` oder `risk: high` (siehe Spec-
   Frontmatter) ist der Merge **immer** ein Human-Gate
   (`gate-id: merge-approval`). Bei `risk: low` genügt ein `gate-resolve`
   nach grüner CI und ohne offene Review-Threads.
9. **Abschluss:** Nach Merge `phase --phase complete` setzen, Run-Dokument im
   Ziel-Repo (analog zu `RUN-XXX`-Dokumenten) ergänzen.

## Nicht verhandelbare Grenzen

- Kein Merge bei `risk: medium`/`risk: high` ohne aufgelöstes Human-Gate.
- Keine echten Nutzerdaten, keine Secrets in Run-State, Logs oder Fixtures.
- Maximal drei automatische Korrekturiterationen pro Run.
- Destruktive Migrationen, Auth-/Berechtigungsänderungen: immer Human-Gate,
  unabhängig vom deklarierten Risiko der Spec.
- Bei Widersprüchen zwischen Requirement, Spec und Issue: nicht raten, Human-
  Gate öffnen und Konflikt im `question`-Feld benennen.

## Agent Iteration Feedback Loop

When an agent (e.g., GitHub Copilot) fails to fix failing tests, the system:

1. **Automatic Detection** (`agent-fix-failing-tests.yml`):
   - Triggers on workflow failures (Repository Quality, Preview E2E)
   - Finds the open draft PR by the agent
   - Posts a comment on the tracking issue with failing checks summary
   - Calls `harness iteration-start` to track the attempt

2. **Iteration Tracking**:
   - Each failed attempt is recorded in `state.iterations[]`
   - Failed iterations counted toward `maxAutomaticIterations` (default: 3)

3. **Escalation** (`computeNextAction`):
   - Once `iterationCapReached(state) == true`, next `resume` generates `escalate-iteration-cap` action
   - This triggers a human gate for manual intervention

**Result**: Runaway agent failures don't block forever — they escalate automatically after 3 failed attempts.
