---
id: SPEC-007
type: software-spec
title: Reaktive Spec-zu-Issue-Pipeline und Freigabe-Label-Bündelung als Workflow-Vorlagen
status: approved
owner: engineering
risk: medium
requirements:
  - REQ-007
implementation_assignee: "@github-copilot"
created: 2026-08-07
updated: 2026-08-10
---

# SPEC-007: Reaktive Spec-zu-Issue-Pipeline und Freigabe-Label-Bündelung als Workflow-Vorlagen

## Zusammenfassung

Zwei neue Einträge im Vorlagen-Katalog aus SPEC-006 — `spec-to-issue` und
`label-approval-bundling` — bilden reaktiv nach, was Immogent bisher lokal
in `spec-to-issue.yml`, `harness-approve-for-agent.yml` und
`scripts/create_issue_from_spec.py` nachgebaut hat. Die Issue-Erzeugung
aus einer freigegebenen Spec wandert als TypeScript-Funktion in den
Harness-Kern und wird sowohl vom bestehenden CLI-Pfad (`harness
issue-create`, REQ-003) als auch von der neuen reaktiven Pipeline
verwendet, damit Titel-/Body-Format an genau einer Stelle gepflegt wird.

## Technische Entscheidungen

1. Neues Modul `src/spec/issue-from-spec.ts` extrahiert die bisher in
   Immogents `scripts/create_issue_from_spec.py` implementierte Logik
   (Frontmatter lesen, `status: approved` und `type: software-spec`
   prüfen, Titel `<SPEC-ID>: <Titel>` gemäß der in SKILL.md/AGENTS.md
   festgelegten Konvention, Body mit Requirements-Liste, Abschnitt
   „Zerlegung in Issues“ sofern vorhanden, Definition of Ready) als
   reine, testbare Funktion `buildIssueFromSpec(specContent, options):
   { title, body }`.
2. `harness issue-create` (bestehend, REQ-003) kann optional
   `buildIssueFromSpec()` statt eines manuell übergebenen Titels/Bodys
   verwenden (`--from-spec-path`), damit beide Pfade dieselbe Logik
   nutzen.
3. Zwei neue reusable Workflows in `pi-spec-harness`:
   - `.github/workflows/spec-to-issue.yml` (`workflow_call`, Inputs:
     `spec-path-glob`, `default-branch`), triggerbar über eine dünne
     Referenzdatei mit `on: push: paths: [<spec-path-glob>]`.
   - `.github/workflows/label-approval-bundling.yml` (`workflow_call`,
     Inputs: `trigger-label`, `target-labels` als JSON-Array), triggerbar
     über eine dünne Referenzdatei mit `on: issues: types: [labeled]`.
4. Beide reusable Workflows werden über
   `WORKFLOW_TEMPLATE_CATALOG` (SPEC-006) referenzierbar; ihre
   Referenzdateien folgen demselben Managed-Marker-Muster wie
   `bug-triage`.
5. Der Idempotenz-Check vor Issue-Erzeugung sucht per `gh issue list
   --state all --search "in:title \"<SPEC-ID>\""` breit nach der Spec-ID
   im Titel (nicht nach dem vollen erwarteten Titelformat), damit sowohl
   ein über diese Pipeline als auch ein über `harness issue-create`
   erzeugtes Issue erkannt wird.
5a. `label-approval-bundling.yml` ruft nach dem Setzen der gebündelten
   Label zusätzlich, im selben Workflow-Lauf, `harness init --repository
   <repo> --run-id <deterministisch aus Implementierungs-Issue-Nummer
   abgeleitet, z. B. "issue-<number>"> --requirement <aus Spec-Frontmatter>
   --spec <Spec-Pfad>` auf. `harness init` ist bereits idempotent
   (find-or-create des Tracking-Issues); ein bereits bestehender Run für
   dieselbe Run-ID wird unverändert weiterverwendet, es entsteht kein
   zweites Tracking-Issue. Der Aufruf läuft vollständig non-interaktiv
   über `GITHUB_TOKEN`, ohne Chat-Sitzung und ohne manuellen CLI-Aufruf.
5b. Die Run-ID-Ableitung (`issue-<implementation-issue-number>`) ist
   stabil und wird dokumentiert, damit jeder spätere Aufruf (manuell oder
   durch eine andere Action) denselben Run findet, statt einen weiteren
   anzulegen.
6. `label-approval-bundling` liest beim Event `issues.labeled` nur, wenn
   `github.event.label.name == inputs.trigger-label`, und setzt dann alle
   in `inputs.target-labels` genannten Label über eine einzige
   `gh issue edit --add-label`-Aktion.
7. Beide Workflows erhalten ausschließlich `issues: write` (kein
   `contents: write`, kein Zugriff auf Secrets außer `GITHUB_TOKEN`).
8. Immogents bestehende `spec-to-issue.yml`/`harness-approve-for-agent.yml`
   werden durch diese Spec nicht automatisch ersetzt; die Migration ist
   ein separater, manueller Schritt (siehe Nicht-Ziele in REQ-007).

## Technische Akzeptanzkriterien

- TAC-01: `buildIssueFromSpec()` erzeugt für eine Test-Spec mit
  `status: approved` denselben Titel- und Body-Inhalt wie das bisherige
  Immogent-Skript für dieselbe Eingabe (Migrations-Regressionstest anhand
  einer eingefrorenen Beispiel-Spec).
- TAC-02: `buildIssueFromSpec()` wirft für `status != approved` oder
  fehlende `requirements[]` einen typisierten Fehler, ohne ein
  Teilergebnis zurückzugeben.
- TAC-03: `harness issue-create --from-spec-path <pfad>` erzeugt ein
  Issue mit dem von `buildIssueFromSpec()` gelieferten Titel/Body und
  öffnet weiterhin das `issue-ready`-Gate wie im bestehenden Verhalten.
- TAC-04: Der reusable Workflow `spec-to-issue.yml` erzeugt bei einem
  Push, der eine Spec mit `status: approved` unter dem konfigurierten
  Glob ändert, genau ein Issue.
- TAC-05: Derselbe Push-Test mit `status: draft` oder `status: review`
  erzeugt kein Issue.
- TAC-06: Ein zweiter Push ohne inhaltliche Änderung der Spec (oder mit
  bereits existierendem Issue für dieselbe Spec-ID) erzeugt kein zweites
  Issue.
- TAC-07: Ein manuell über `harness issue-create` erzeugtes Issue für
  dieselbe Spec-ID verhindert nachweislich, dass der reaktive Workflow
  ein weiteres Issue erzeugt (Cross-Pfad-Idempotenz).
- TAC-08: `label-approval-bundling.yml` setzt bei
  `issues.labeled` mit `trigger-label` nachweislich alle konfigurierten
  `target-labels`; ein `labeled`-Event mit einem anderen Label setzt
  nichts.
- TAC-09: Wiederholtes Setzen desselben `trigger-label` erzeugt keinen
  Fehler und keine doppelten Label-Events (GitHub verhindert doppelte
  Label ohnehin; der Test prüft, dass der Workflow dabei nicht
  fehlschlägt).
- TAC-10: Beide Referenzdateien folgen dem Managed-Marker-Muster aus
  SPEC-006 und sind über `WORKFLOW_TEMPLATE_CATALOG` auffindbar.
- TAC-12: `label-approval-bundling.yml` ruft nach dem Setzen der Label
  nachweislich `harness init` mit der deterministisch abgeleiteten
  Run-ID auf; im Anschluss existiert ein Tracking-Issue mit `harness:run`,
  dessen Run-State die Implementierungs-Issue-Nummer, die Requirement-
  und die Spec-Referenz enthält.
- TAC-13: Ein zweiter Trigger auf dasselbe Issue (z. B. `trigger-label`
  versehentlich erneut gesetzt) führt bei bereits bestehendem Run zu
  `noop` auf `harness init`-Ebene; es entsteht kein zweites
  Tracking-Issue und kein zweiter Run-Eintrag.
- TAC-14: Bereits vor dem automatischen `harness init`-Aufruf manuell
  gestartete Runs (Run-ID kollidiert mit der deterministischen Ableitung)
  werden unverändert weiterverwendet; der automatische Aufruf überschreibt
  keinen bestehenden Run-State.
- TAC-11: Dokumentation (`docs/workflow.md`, `skills/pi-spec-harness/SKILL.md`)
  beschreibt den reaktiven Einstiegspunkt als Ergänzung zum bestehenden
  CLI-Pfad und verweist auf die Migrationsmöglichkeit für
  Referenzprojekte mit lokal gepflegten Äquivalenten.

## Verifikation

- `npm run check`,
- Migrations-Regressionstest `buildIssueFromSpec()` gegen eingefrorene
  Immogent-Beispiel-Spec,
- Contract-Tests für `spec-to-issue.yml`: approved/nicht-approved,
  Duplikat-Erkennung, Cross-Pfad-Idempotenz mit `harness issue-create`,
- Contract-Tests für `label-approval-bundling.yml`: richtiges/falsches
  Trigger-Label, wiederholtes Label,
- Contract-Test für automatisches `harness init` nach Label-Bündelung:
  Tracking-Issue entsteht mit korrektem Run-State; wiederholter Trigger
  erzeugt keinen zweiten Run; vorbestehender Run wird nicht überschrieben,
- isolierter Smoke-Run mit einer synthetischen Spec in einem
  Test-Repository.

## Rollback

Beide Vorlagen sind über `--install-workflows spec-to-issue` bzw.
`--install-workflows label-approval-bundling` einzeln aktivierbar. Ein
Repository, das `harness init` ohne diese Namen ausführt oder die
installierten Referenzdateien entfernt, erhält bzw. behält die
Fähigkeiten nicht. Bestehende, unabhängig gepflegte Referenzprojekt-
Workflows (z. B. Immogents heutige Dateien) bleiben von dieser Spec
unberührt, bis ihre Migration bewusst durchgeführt wird.
