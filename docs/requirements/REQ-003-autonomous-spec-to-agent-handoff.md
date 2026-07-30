---
id: REQ-003
type: requirement
title: Autonome Übergabe von freigegebener Spec an den Coding Agent
status: approved
owner: product
risk: high
created: 2026-07-30
updated: 2026-07-30
---

# REQ-003: Autonome Übergabe von freigegebener Spec an den Coding Agent

## Problem

Nach einer korrekt verarbeiteten Spec-Freigabe sind derzeit mehrere manuelle
Eingriffe erforderlich: Dokumentstatus committen, neuen Head binden, Phasen
weiterschalten, ein vollständiges Issue erzeugen, Labels prüfen, Copilot über
eine separate API zuweisen und dessen Pull Request auf den richtigen
Spec-Branch umstellen.

Die CLI kann dabei Erfolg melden, obwohl der mehrzeilige Issue-Body
abgeschnitten, Labels nicht gesetzt oder Copilot nicht tatsächlich zugewiesen
wurde. Außerdem unterscheidet der Run-State noch nicht eindeutig zwischen dem
Delivery-PR gegen den Default-Branch und dem Implementierungs-PR des Coding
Agents gegen den Delivery-Branch.

## Nutzer-Outcome

Nach Freigabe von Requirement und Software-Spec setzt der Harness den Run ohne
Babysitting bis zur nächsten echten Entscheidung fort. Er persistiert die
Freigabe auf dem exakten Delivery-Branch, erzeugt und verifiziert ein
vollständiges Implementierungs-Issue, startet den vorgesehenen Coding Agent
auf der richtigen Basis und verfolgt dessen Implementierungs-PR eindeutig.

## Akzeptanzkriterien

- AC-01: Eine Spec-Freigabe aktualisiert ausschließlich die im Run-State
  gebundenen Requirement- und Spec-Dateien auf dem gebundenen Delivery-Branch.
- AC-02: Vor jedem Commit prüft der Harness Repository, Branch und vollständige
  Head-SHA; `main` wird niemals direkt beschrieben.
- AC-03: Der durch die Statusänderung entstandene Head wird automatisch als
  neuer Delivery-Checkpoint gebunden.
- AC-04: Deterministische, gate-freie Phasen werden selbstständig und jeweils
  nachvollziehbar fortgesetzt; echte Arbeit oder offene Gates stoppen den Lauf.
- AC-05: Das Implementierungs-Issue enthält den vollständigen freigegebenen
  Scope, Akzeptanzkriterien, Sicherheitsregeln, Run-ID und Tracking-Issue.
- AC-06: Angeforderte Labels und Assignees werden nach der GitHub-Schreibaktion
  erneut gelesen; erst die verifizierte Realität darf das `issue-ready`-Gate
  bestehen.
- AC-07: GitHub Copilot wird über die unterstützte Coding-Agent-API tatsächlich
  zugewiesen. Ein bloßer Hinweis im Body zählt nicht als Zuweisung.
- AC-08: Der Coding Agent startet vom gebundenen Delivery-Branch und eröffnet
  seinen Implementierungs-PR gegen genau diesen Branch.
- AC-09: Delivery-PR und Implementierungs-PR werden getrennt und mit ihren
  vollständigen Head-SHAs im Run-State geführt.
- AC-10: Der Implementierungs-PR darf erst nach grünen Checks und gelösten
  Review-Threads in den Delivery-Branch übernommen werden.
- AC-11: Der finale Delivery-PR wird nach der Übernahme erneut geprüft und bei
  hohem Risiko nur nach einem SHA-spezifischen Human-Gate nach `main` gemerged.
- AC-12: Wiederholte Events und Wiederanläufe sind idempotent und erzeugen
  weder doppelte Issues noch doppelte Agent-Aufträge oder PR-Zuordnungen.

## Nicht-Ziele

- direkter Coding-Agent-Push nach `main`,
- Auto-Merge des finalen Delivery-PRs ohne risikobasiertes Human-Gate,
- freie KI-Generierung eines vom freigegebenen Scope abweichenden Issues,
- periodisches Polling als Voraussetzung für Fortschritt,
- Änderungen an Immogent-Fachfunktionen.
