---
id: SPEC-004
type: software-spec
title: Bug-zu-PR-Pipeline über Claude Cloud Agent
status: review
owner: engineering
risk: high
requirements:
  - REQ-004
implementation_assignee: "@github-copilot"
created: 2026-08-04
updated: 2026-08-04
---

# SPEC-004: Bug-zu-PR-Pipeline über Claude Cloud Agent

## Zusammenfassung

Der Harness erhält einen zweiten, schlankeren Run-Pfad neben dem
bestehenden Requirement/Spec-gesteuerten Feature-Pfad: einen Bug-Track, der
direkt bei einem neu angelegten Issue vom Typ `Bug` beginnt. Ein
wiederverwendbarer, zentral im `pi-spec-harness`-Repo gepflegter GitHub-
Action-Workflow beauftragt `claude-code-action` (gepinnt) als Cloud-Agent,
der den Bug analysiert, reproduziert, das Issue anreichert und in einem
durchgehenden Lauf einen Fix samt Pull Request erzeugt. `harness init`
installiert in jedem angebundenen Repository nur eine minimale
Referenzdatei, die auf diesen zentralen Workflow verweist, damit
Verbesserungen an einer Stelle gepflegt werden.

Der Merge des entstandenen PRs bleibt unverändert durch die bestehenden
Verifikations- und Human-Gate-Mechanismen geschützt; dieser Spec fügt keinen
neuen Automerge-Pfad hinzu.

## Technische Entscheidungen

1. Ein neuer reusable Workflow `.github/workflows/bug-triage.yml` in
   `pi-spec-harness` wird per `workflow_call` von einer dünnen
   Referenzdatei in jedem Zielrepository aufgerufen
   (`uses: munichdeveloper/pi-spec-harness/.github/workflows/bug-triage.yml@<pinned-sha-or-tag>`).
2. Der Trigger im Zielrepository reagiert auf `issues: [opened, typed,
   labeled]` und filtert serverseitig auf `github.event.issue.type.name ==
   'Bug'` oder Label `type:bug`; alle anderen Issues lösen nichts aus.
3. `harness init` erhält eine neue, optionale Aktion: Schreiben/Aktualisieren
   der Referenz-Workflow-Datei im Zielrepository über die Contents API
   (analog zu `updateFileOnBranch`), idempotent und ohne bestehende,
   abweichende Workflows zu überschreiben.
4. Der reusable Workflow ruft `claude-code-action` in einer über
   Repository-Variable oder Workflow-Input gepinnten Version `>=1.0.94` auf;
   ein Versions-Check schlägt den Lauf fehl, falls die Version älter oder
   ungepinnt ist.
5. Der Agent-Prompt instruiert Claude, das Issue im Repository-Kontext zu
   analysieren, eine Reproduktion zu versuchen (bevorzugt ein
   fehlschlagender Test), die Befunde als Issue-Kommentar zu hinterlegen und
   danach ohne Zwischenstopp Fix und PR zu erzeugen.
6. Gelingt keine eindeutige Reproduktion/Verifikation, beendet der Agent den
   Lauf ohne PR, kommentiert die Unsicherheit und der Workflow setzt das
   Label `status:needs-human` auf das Issue.
7. Ein Idempotenz-Label (`bug-pipeline:in-progress`) wird vor Agent-Start
   gesetzt und geprüft; ein bereits laufender oder abgeschlossener Lauf für
   dasselbe Issue verhindert einen zweiten parallelen Agent-Start.
8. Nach PR-Erstellung fügt der Workflow den Issue-Autor bzw. konfigurierten
   Owner als Reviewer/Assignee auf dem PR hinzu.
9. Bestehende PR-Verifikations- und Merge-Gate-Mechanismen (CI, Review-
   Threads, ggf. repository-eigene Preview-E2E) bleiben unverändert
   zuständig; dieser Spec fügt keinen neuen Merge-Pfad hinzu und markiert
   den PR nicht als auto-mergefähig.
10. `claude-code-action` erhält minimal nötige Berechtigungen (Schreiben nur
    auf einem neuen Feature-Branch, kein direkter Push nach dem
    Default-Branch), analog zum bestehenden Grundsatz „niemals direkt auf
    main“.

## Technische Akzeptanzkriterien

- TAC-01: `bug-triage.yml` existiert als `workflow_call`-fähiger Workflow in
  `pi-spec-harness` mit klar definierten Inputs (u. a. gepinnte
  `claude-code-action`-Version, optionaler Preview-Verifikationsbefehl).
- TAC-02: Die im Zielrepository installierte Referenzdatei ist minimal (nur
  Trigger + `uses:`-Aufruf) und enthält keine wiederholte Fachlogik.
- TAC-03: `harness init` schreibt die Referenzdatei nur, wenn sie fehlt oder
  von der aktuellen Referenzversion abweicht; ein manuell abweichender
  Workflow im Zielrepo wird nicht stillschweigend überschrieben, sondern
  meldet einen Konflikt.
- TAC-04: Der Trigger-Filter verifiziert `issue.type.name == 'Bug'` bzw. das
  Label `type:bug`serverseitig vor jedem Agent-Aufruf; andere Issues
  erzeugen keinen Workflow-Run mit Schreibrechten.
- TAC-05: Ein Versions-Gate bricht den Lauf ab, falls die konfigurierte
  `claude-code-action`-Version unterhalb `1.0.94` liegt oder nicht auf
  einen festen Tag/SHA gepinnt ist.
- TAC-06: Der Agent-Lauf hinterlässt in jedem Fall (Erfolg wie Misserfolg)
  einen Issue-Kommentar mit seinen Befunden, bevor der Workflow endet.
- TAC-07: Bei nicht reproduzierbarem/nicht verifizierbarem Bug wird kein PR
  erzeugt; stattdessen wird `status:needs-human` gesetzt und der Lauf endet
  ohne Fehlerstatus.
- TAC-08: Ein Idempotenz-Label verhindert nachweislich einen zweiten
  parallelen Agent-Lauf bei wiederholten Trigger-Events auf demselben Issue
  (getestet mit doppelter Zustellung).
- TAC-09: Nach erfolgreicher PR-Erstellung ist der konfigurierte
  Reviewer/Owner nachweislich als Reviewer auf dem PR gesetzt.
- TAC-10: Bestehende PR-Verifikations-Workflows laufen unverändert gegen den
  vom Agent erzeugten PR; dieser Spec ändert keine bestehenden Merge- oder
  Gate-Regeln.
- TAC-11: Tests/Contract-Checks decken ab: Issue ohne Typ Bug (kein
  Trigger), doppeltes Event (kein Doppel-Lauf), fehlgeschlagene
  Reproduktion (kein PR, `status:needs-human`), erfolgreicher Lauf (PR +
  Reviewer gesetzt), veraltete Action-Version (Abbruch).
- TAC-12: Dokumentation beschreibt den Bug-Track als eigenständigen,
  schlankeren Run-Pfad neben dem Feature-Pfad und grenzt ihn im
  `docs/workflow.md` klar ab.

## Verifikation

- `npm run check`,
- Contract-Tests für den Trigger-Filter (Issue-Typ/Label, doppelte Events),
- Contract-Tests für das Versions-Gate der `claude-code-action`,
- isolierter Smoke-Run mit einem synthetischen Bug-Issue in einem
  Test-Repository,
- Prüfung, dass kein Lauf ohne vorherigen Issue-Kommentar einen PR erzeugt,
- Prüfung, dass bestehende Merge-Gates (Human-Gate bei `risk >= medium`)
  unverändert wirksam bleiben.

## Rollback

Der Bug-Track wird über einen eigenen, optional aktivierbaren reusable
Workflow ausgeliefert. Repositories, die `harness init` ohne diese Option
ausführen bzw. die Referenzdatei entfernen, erhalten den Bug-Track nicht.
Ein Entfernen der Referenzdatei im Zielrepository deaktiviert die Pipeline
dort vollständig, ohne den bestehenden Feature-Pfad zu beeinträchtigen.
