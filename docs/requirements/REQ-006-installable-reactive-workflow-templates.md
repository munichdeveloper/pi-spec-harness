---
id: REQ-006
type: requirement
title: Generischer Installationsmechanismus für reaktive Workflow-Vorlagen
status: approved
owner: product
risk: medium
created: 2026-08-07
updated: 2026-08-07
---

# REQ-006: Generischer Installationsmechanismus für reaktive Workflow-Vorlagen

## Problem

Der Harness soll laut Anspruch "headless" laufen: Ereignisse im
angebundenen Repository lösen ohne offene Agenten-Sitzung automatisch den
nächsten Schritt aus (siehe `docs/event-driven-workflow.md`). Für den
Bug-Track (REQ-004/SPEC-004) existiert dieses Muster bereits als
funktionierender, spezifischer Mechanismus: `harness init
--install-bug-workflow` schreibt eine dünne Referenzdatei in das
Zielrepository, die per `uses:` einen zentral im Harness gepflegten
reusable Workflow aufruft.

Dieser Mechanismus ist jedoch fest auf den Bug-Track verdrahtet
(`installBugWorkflow`, `renderBugWorkflowReference`,
`decideBugWorkflowInstall` sind bug-spezifisch benannt und implementiert).
Für weitere reaktive Fähigkeiten — etwa die automatische Erzeugung eines
Implementierungs-Issues aus einer freigegebenen Spec ohne aktiven
CLI-gesteuerten Run (siehe REQ-007) — musste dieselbe Grundidee im
Referenzprojekt Immogent unabhängig nachgebaut werden
(`spec-to-issue.yml`, `harness-approve-for-agent.yml`,
`scripts/create_issue_from_spec.py`). Damit entstanden zwei parallele,
unabhängig gepflegte Implementierungen derselben Idee statt einer
zentralen.

## Nutzer-Outcome

`harness init` kann eine benannte Menge reaktiver Workflow-Vorlagen
(z. B. `bug-triage`, `spec-to-issue`, `label-approval-bundling`) in ein
beliebiges angebundenes Repository installieren bzw. aktualisieren. Jede
Vorlage besteht aus einer minimalen, versionsgebundenen Referenzdatei im
Zielrepository und einem zentral im Harness-Repository gepflegten reusable
Workflow. Eine manuell abweichende, bereits vorhandene Workflow-Datei wird
nicht stillschweigend überschrieben. Neue reaktive Fähigkeiten werden als
zusätzlicher Eintrag in einem Vorlagen-Katalog ergänzt, ohne den
Installationsmechanismus selbst zu ändern.

## Akzeptanzkriterien

- AC-01: Ein Vorlagen-Katalog im Harness beschreibt für jede reaktive
  Fähigkeit Name, Zielpfad der Referenzdatei im Zielrepository, Pfad des
  reusable Workflows im Harness-Repository und einen eindeutigen
  Managed-Marker.
- AC-02: `harness init --install-workflows <name>[,<name>...]` installiert
  bzw. aktualisiert für jeden genannten Namen die zugehörige Referenzdatei;
  nicht genannte, bereits installierte Vorlagen bleiben unverändert.
- AC-03: Der bestehende Bug-Workflow-Mechanismus (`--install-bug-workflow`)
  wird auf den generischen Katalog umgestellt und verhält sich für
  Bestandsnutzer unverändert (gleicher Zielpfad, gleicher Marker, gleiches
  Default-Ref-Verhalten).
- AC-04: Jede installierte Referenzdatei ist minimal (Trigger-Definition
  plus `uses:`-Aufruf mit Inputs) und enthält keine wiederholte
  Fachlogik.
- AC-05: Der reusable Workflow jeder Vorlage wird über einen fixierbaren
  Ref (Tag oder SHA) referenziert; ein Default-Ref ist pro Vorlage
  konfiguriert.
- AC-06: Eine Installation erkennt zuverlässig zwischen `create` (Datei
  fehlt), `noop` (Datei entspricht bereits der erwarteten Version),
  `update-managed` (Datei trägt den Marker, Inhalt weicht ab) und
  `conflict` (Datei existiert ohne Marker); nur bei `conflict` erfolgt kein
  Schreibzugriff, stattdessen eine sichtbare Meldung.
- AC-07: Projektspezifische Parameter (z. B. Pfad des Spec-Verzeichnisses,
  zu beobachtende Workflow-Namen) werden als Inputs der Referenzdatei
  übergeben, nicht in den zentralen reusable Workflow einkompiliert.
- AC-08: Die Installation ist idempotent: wiederholter Aufruf mit
  unveränderten Parametern erzeugt keine Änderung und keinen Fehler.
- AC-09: Bestehende, nicht auf diesen Mechanismus umgestellte
  Referenzprojekt-eigene Workflows (z. B. Immogents heutige
  `spec-to-issue.yml`) werden durch die Einführung dieses Mechanismus
  nicht automatisch verändert oder entfernt; die Migration erfolgt als
  bewusster, separater Schritt pro Repository.

## Nicht-Ziele

- automatische Migration bestehender, handgeschriebener
  Referenzprojekt-Workflows ohne expliziten Aufruf,
- ein allgemeiner Plugin- oder Marketplace-Mechanismus für
  fremde/Drittanbieter-Workflows,
- Versionsauflösung über Semver-Ranges (nur exakte Tag-/SHA-Pinning wie
  beim bestehenden Bug-Workflow),
- Entfernen/Deinstallieren von Vorlagen in dieser ersten Ausbaustufe
  (Rollback bleibt manuell: Referenzdatei im Zielrepo löschen).
