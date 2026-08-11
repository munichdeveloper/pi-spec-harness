---
id: SPEC-006
type: software-spec
title: Generischer Katalog und Installationsmechanismus für reaktive Workflow-Vorlagen
status: approved
owner: engineering
risk: medium
requirements:
  - REQ-006
created: 2026-08-07
updated: 2026-08-07
---

# SPEC-006: Generischer Katalog und Installationsmechanismus für reaktive Workflow-Vorlagen

## Zusammenfassung

Der bestehende, bug-spezifische Referenz-Workflow-Mechanismus
(`src/bug/workflow-reference.ts`, `--install-bug-workflow`) wird zu einem
generischen Vorlagen-Katalog verallgemeinert. Ein Katalogeintrag
beschreibt Zielpfad, Managed-Marker, reusable-Workflow-Pfad und
Default-Ref einer reaktiven Fähigkeit. `harness init` erhält eine neue
Option `--install-workflows <name>[,<name>...]`, die für jeden genannten
Katalogeintrag die zugehörige Referenzdatei schreibt oder aktualisiert.
Der Bug-Workflow wird der erste Katalogeintrag; ein zweiter Eintrag
(`spec-to-issue`, siehe SPEC-007) folgt als erster neuer Konsument dieses
Mechanismus.

## Technische Entscheidungen

1. Neues Modul `src/workflows/template-catalog.ts` definiert
   `WorkflowTemplateDefinition { name, targetPath, marker,
   reusableWorkflowRepoPath, defaultRef, renderReference(options) }` und
   einen `WORKFLOW_TEMPLATE_CATALOG: WorkflowTemplateDefinition[]`.
2. `src/bug/workflow-reference.ts` wird nicht gelöscht, sondern registriert
   sich als erster Katalogeintrag (`name: "bug-triage"`); bestehende
   Exporte (`BUG_WORKFLOW_REFERENCE_PATH`, `DEFAULT_BUG_TRIAGE_WORKFLOW_REF`
   usw.) bleiben für Rückwärtskompatibilität erhalten und werden vom
   Katalogeintrag referenziert, nicht dupliziert.
3. `decideBugWorkflowInstall()` wird zu einer generischen
   `decideWorkflowInstall(existingContent, expectedContent, marker)`
   verallgemeinert; die bug-spezifische Funktion bleibt als dünner Wrapper
   für Bestandscode erhalten.
4. `cmdInit` in `src/cli.ts` erhält die Option `--install-workflows`
   (kommagetrennte Namen) zusätzlich zum bestehenden
   `--install-bug-workflow`-Flag; beide können kombiniert werden, ohne
   dass doppelte Schreibaktionen für denselben Katalogeintrag entstehen.
5. Für jeden angeforderten, aber im Katalog unbekannten Namen bricht
   `cmdInit` mit einer Fehlermeldung ab, bevor irgendeine Datei geschrieben
   wird (Validierung vor Effekt, analog zu bestehenden Grundsätzen in
   `AGENTS.md`).
6. Projektspezifische Parameter (z. B. `spec_path_glob` für
   `spec-to-issue`, beobachtete Workflow-Namen für einen künftigen
   `process-audit`-Eintrag) werden als optionale CLI-Argumente
   entgegengenommen und in `renderReference()` als Workflow-`with:`-Inputs
   der Referenzdatei eingebettet, nicht in den reusable Workflow selbst.
7. Jede Katalog-Referenzdatei nutzt weiterhin die Contents API
   (`updateFileOnBranch`, analog zum bestehenden Bug-Workflow-Pfad) für
   idempotentes Schreiben/Aktualisieren.

## Technische Akzeptanzkriterien

- TAC-01: `WORKFLOW_TEMPLATE_CATALOG` enthält mindestens den migrierten
  `bug-triage`-Eintrag mit unverändertem Zielpfad, Marker und Default-Ref
  gegenüber dem bisherigen Bug-Workflow-Mechanismus.
- TAC-02: `harness init --install-bug-workflow` erzeugt bei identischen
  Parametern byteidentische Referenzdateien wie vor dieser Änderung
  (Regressionstest gegen den bisherigen `renderBugWorkflowReference()`
  -Output).
- TAC-03: `harness init --install-workflows bug-triage` erzeugt dasselbe
  Ergebnis wie `--install-bug-workflow` für denselben Zielpfad.
- TAC-04: `harness init --install-workflows unknown-name` bricht mit
  einer klaren Fehlermeldung ab und schreibt keine Datei.
- TAC-05: `decideWorkflowInstall()` liefert nachweislich `create`, `noop`,
  `update-managed` und `conflict` für die vier entsprechenden
  Ausgangszustände (Datei fehlt / identisch / mit Marker abweichend / ohne
  Marker vorhanden), unabhängig vom konkreten Katalogeintrag.
- TAC-06: Ein `conflict`-Ergebnis überschreibt nachweislich keine Datei
  und meldet dies im CLI-Ergebnis (`result.conflicts[]` o. ä.), sodass
  ein aufrufender Workflow dies sichtbar machen kann.
- TAC-07: Zwei aufeinanderfolgende Aufrufe mit identischen Parametern
  ergeben beim zweiten Aufruf `noop` für alle betroffenen Vorlagen
  (Idempotenz).
- TAC-08: Bestehende Bug-Workflow-Contract-Tests (siehe
  `test/workflow-contracts.test.ts`) bleiben unverändert grün.
- TAC-09: Dokumentation (`README.md`, `docs/workflow.md`) beschreibt den
  generischen Katalog-Mechanismus und listet die verfügbaren
  Vorlagennamen.

## Verifikation

- `npm run check`,
- Regressionstest: `--install-bug-workflow`-Output vor/nach dieser
  Änderung ist identisch,
- Contract-Tests für alle vier `decideWorkflowInstall()`-Ausgänge,
- Contract-Test für unbekannten Vorlagennamen (Abbruch ohne Schreibzugriff),
- Contract-Test für kombinierte `--install-bug-workflow
  --install-workflows spec-to-issue` (keine doppelte Schreibaktion für
  `bug-triage`).

## Rollback

Der generische Katalog ist additiv: Bestehende Aufrufe mit
`--install-bug-workflow` bleiben unverändert funktionsfähig (TAC-02). Ein
Rollback dieser Spec entfernt nur den generischen `--install-workflows`
-Pfad und das Katalog-Modul; der bug-spezifische Mechanismus bleibt davon
unberührt, da er weiterhin über seine eigenen, nicht entfernten Exporte
funktioniert.
