---
id: SPEC-003
type: software-spec
title: Verifizierte Spec-zu-Agent-Orchestrierung
status: review
owner: engineering
risk: high
requirements:
  - REQ-003
implementation_assignee: "@github-copilot"
created: 2026-07-30
updated: 2026-07-30
---

# SPEC-003: Verifizierte Spec-zu-Agent-Orchestrierung

## Zusammenfassung

Der Harness erhält einen idempotenten Orchestrierungsschritt, der nach einer
Human-Entscheidung deterministische Folgeaktionen ausführt und bei der nächsten
echten Arbeit oder Entscheidung stoppt. Die Übergabe an GitHub Copilot wird
über die offizielle Coding-Agent-API vorgenommen und anschließend gegen den
tatsächlichen GitHub-Zustand verifiziert.

Der Run unterscheidet künftig einen Delivery-PR gegen den Default-Branch von
einem Implementierungs-PR des Coding Agents gegen den Delivery-Branch. Der
Agenten-PR darf nach technischer Verifikation automatisiert in den
Delivery-Branch übernommen werden; der risikoreiche finale Merge nach `main`
bleibt durch ein Human-Gate geschützt.

## Technische Entscheidungen

1. `RunState` erhält rückwärtskompatible, getrennte Bindungen für
   Delivery-PR und Implementierungs-PR einschließlich vollständiger Head-SHAs.
2. Requirement- und Spec-Pfade werden beim Run-Start explizit gespeichert;
   Glob- oder „neueste Datei“-Auswahl ist für Schreibaktionen unzulässig.
3. Ein idempotenter `continue`- beziehungsweise Orchestrierungsbefehl führt nur
   bekannte Phasenhandler aus und stoppt an Arbeit, Fehlern oder Gates.
4. Die Spec-Freigabe erzeugt einen normalen Commit ausschließlich auf dem
   gebundenen Delivery-Branch, nachdem dessen Remote-Head der gebundenen SHA
   entspricht.
5. Issue-Inhalte werden aus den freigegebenen Dokumenten über eine
   dateibasierte oder API-native Payload übertragen; mehrzeiliger Inhalt wird
   niemals als ungesicherte Shell-Argumentfolge behandelt.
6. Das `issue-ready`-Gate wird ausschließlich aus erneut gelesenem GitHub-State
   aufgelöst.
7. Copilot-Verfügbarkeit wird über `suggestedActors` geprüft und die Zuweisung
   über GitHubs Agent-Assignment-API mit `baseRef = deliveryBranch` ausgeführt.
8. Ist Copilot nicht verfügbar oder weicht der erzeugte PR von der erwarteten
   Basis ab, öffnet der Harness ein Human-Gate statt Erfolg zu behaupten.
9. Der Implementierungs-PR wird erst nach grüner CI und aufgelösten
   Review-Threads automatisiert in den Delivery-Branch gemerged. Danach wird
   der Delivery-Head neu gebunden und dessen Evidence invalidiert.
10. Der finale Merge des Delivery-PRs bleibt bei `risk: high` menschlich und
    SHA-spezifisch freizugeben.

## Technische Akzeptanzkriterien

- TAC-01: `RunState` und Schema unterstützen `deliveryPullRequest`,
  `deliveryHeadSha`, `implementationPullRequest`,
  `implementationHeadSha`, `requirementPath` und `specPath`, ohne bestehende
  States unlesbar zu machen.
- TAC-02: Ein Spec-Approval-Handler validiert Gate, Pfade, Branch und Remote-SHA
  und ändert nur `status: review` zu `status: approved`.
- TAC-03: Der Approval-Commit wird ausschließlich auf den Delivery-Branch
  gepusht und danach atomar als neuer Delivery-Checkpoint gespeichert.
- TAC-04: Der Orchestrator führt monotone Einzelschritte mit begrenzter
  Schrittzahl aus und gibt jeden ausgeführten Schritt sowie den nächsten
  Stop-Grund strukturiert aus.
- TAC-05: Der Issue-Renderer übernimmt Scope, ACs, Nicht-Ziele, Risiko,
  Verifikation und Run-Referenzen vollständig aus REQ und SPEC.
- TAC-06: Issue-Erzeugung ist find-or-create über Run-ID und Tracking-Issue;
  wiederholte Ausführung verwendet dasselbe Issue.
- TAC-07: Body, `harness:implementation`, `status:ready`, `ai:allowed` und der
  tatsächliche Coding-Agent-Assignee werden nach Erstellung verifiziert.
- TAC-08: Die CLI meldet `issue-ready: passed` erst nach erfolgreicher
  Verifikation; Teilfehler bleiben pending oder failed und enthalten Evidence.
- TAC-09: Die Copilot-Zuweisung nutzt die offizielle API, prüft
  `suggestedActors` und setzt den gebundenen Delivery-Branch als `baseRef`.
- TAC-10: Der erzeugte Implementierungs-PR wird aus der Agent-Zuweisung oder
  einer eindeutigen Issue-Verknüpfung ermittelt und gegen Repository, Basis und
  Head-SHA validiert.
- TAC-11: CI- und Review-Gate des Implementierungs-PRs blockieren dessen
  Übernahme in den Delivery-Branch; nach Übernahme wird der Delivery-PR erneut
  SHA-spezifisch verifiziert.
- TAC-12: Workflow-Trigger ruft den Orchestrator nach Gate-Entscheidungen und
  relevanten Agent-/PR-Events auf, serialisiert repositoryweit und bleibt ohne
  periodisches Polling funktionsfähig.
- TAC-13: Tests decken abgeschnittene mehrzeilige Bodies, fehlende Labels,
  vorgetäuschte Assignees, falsche PR-Basis, doppelte Zustellung, veraltete
  Heads, Teilfehler und erfolgreiche Wiederaufnahme ab.
- TAC-14: Dokumentation beschreibt die Zwei-PR-Topologie und unterscheidet
  technische Übernahme in den Delivery-Branch vom finalen Human Merge Gate.

## Verifikation

- `npm run check`,
- State-Machine-, Orchestrator- und GitHub-Adaptertests,
- Workflow-Vertragstests,
- isolierter Smoke-Run mit mehrzeiliger Spec und echter Copilot-Zuweisung,
- Prüfung beider PR-Bindungen und der Branch-Basis,
- keine offenen umsetzbaren Review-Threads,
- SHA-spezifisches Human-Gate vor dem finalen Merge.

## Rollback

Die Orchestrierung wird in einem eigenen Delivery-PR ausgeliefert. Alle
Schreibaktionen erfolgen auf Feature-Branches und bleiben durch normale
GitHub-Reverts rückgängig zu machen. Bei deaktivierter Orchestrierung bleiben
die bestehenden Einzelbefehle als manueller Recovery-Pfad verfügbar.

