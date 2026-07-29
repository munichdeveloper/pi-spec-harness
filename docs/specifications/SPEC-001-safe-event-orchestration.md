---
id: SPEC-001
type: software-spec
title: Run-sichere Event-Orchestrierung und Recovery
status: approved
owner: engineering
risk: high
requirements:
  - REQ-001
implementation_assignee: "@github-copilot"
created: 2026-07-28
updated: 2026-07-28
---

# SPEC-001: Run-sichere Event-Orchestrierung und Recovery

## Zusammenfassung

Der Pi Spec Harness und die Immogent-Automation werden so gehärtet, dass jeder
Event exakt einem Run, einer Spec, einem Implementierungs-Issue und einem PR
zugeordnet ist. Fehlgeschlagene Agentenarbeit wird auf einem Recovery-Branch
bewahrt, niemals auf `main`. Technische Gates werden nur mit belastbarer
Evidence aufgelöst.

## Technische Akzeptanzkriterien

- HVS-01: `RunState` speichert die Nummer des gebundenen Pull Requests und die
  CLI bietet dafür einen idempotenten, konfliktprüfenden Befehl.
- HVS-02: `computeNextAction` blockiert bei jedem pending,
  `needs-human` oder nicht quittierten failed Gate; Human Gates behalten ihre
  besondere Label-Auflösung.
- HVS-03: Ein Phasenwechsel ist monoton, überspringt keine Phase und ist bei
  blockierenden Gates unzulässig; `complete` schließt nur einen belegbar
  abgeschlossenen Run.
- HVS-04: Das Implementierungs-Issue erhält `harness:implementation` statt
  `harness:run` und enthält Run-ID sowie Tracking-Issue-Referenz.
- HVS-05: Gate- und Issue-Workflows lesen Spec-ID, Issue und PR aus dem
  kanonischen Run-State oder einem expliziten Dispatch-Payload; „neueste“
  Ressourcen sind unzulässig.
- HVS-06: Spec-Freigabe aktualisiert ausschließlich die exakt gebundene
  Spec-Datei im eindeutig zugeordneten Spec-PR.
- HVS-07: Verification wird erst bei nicht-draft PR, vollständig
  abgeschlossenen erfolgreichen Checks und ohne offene Review-Threads
  bestanden.
- HVS-08: Bei fehlgeschlagenen Checks wird der PR-Head auf einem eindeutig
  benannten Recovery-Branch gesichert; `main` bleibt unverändert.
- HVS-09: Retry bucht `iteration-start` und `iteration-finish`; nach drei
  Fehlschlägen wird nicht erneut zugewiesen, sondern ein Human Gate geöffnet.
- HVS-10: Merge-Automation arbeitet ausschließlich auf dem im Run-State
  gespeicherten PR und nur nach aufgelöstem `merge-approval`.
- HVS-11: Unit- und Workflow-Vertragstests decken Gate-Blockierung,
  PR-Bindung, Run-Isolation, Recovery und Iterationslimit ab.
- HVS-12: Handover, Human-Gate-Dokumentation, Event-Workflow und Quick
  Reference werden auf das gehärtete Verhalten aktualisiert.

## Sicherheitsregeln

- Kein direkter Push aus Recovery- oder Fehlerworkflows nach `main`.
- Keine Auswahl nach „letztem“, „höchstem“ oder „neuestem“ Issue, PR oder
  Spec-Dokument.
- GitHub-Schreibaktionen bleiben als benannte Funktionen beziehungsweise
  eng begrenzte Workflow-Schritte auditierbar.
- Ein neuer Commit nach einer Gate-Evidence macht die alte SHA-Bindung
  ungültig und erfordert erneute Verifikation.
- Secrets, Mailinhalte und andere Produktdaten bleiben aus Run-State und
  Evidence ausgeschlossen.

## Verifikation

- `npm run check` im Harness,
- Workflow-Syntax- und Vertragstests,
- lokale State-Machine- und CLI-Tests,
- GitHub-PR-Checks in beiden Repositories,
- Human Merge Gate für beide PRs.

## Rollback

Die Workflow-Änderungen werden in getrennten PRs ausgeliefert. Bei einem
Fehler bleiben die bisherigen PR-Branches erhalten. Recovery schreibt niemals
nach `main`, sodass ein Rollback ausschließlich über normale PR-Reverts
erfolgt.
