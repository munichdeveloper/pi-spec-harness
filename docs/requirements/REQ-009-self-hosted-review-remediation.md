---
id: REQ-009
type: requirement
title: Self-hosted Harness und automatische Behebung von Review-Kommentaren
status: approved
owner: product
risk: medium
created: 2026-08-12
updated: 2026-08-12
---

# REQ-009: Self-hosted Harness und automatische Behebung von Review-Kommentaren

## Problem

Der Harness orchestriert Zielrepositories, wird in seinem eigenen Repository
aber noch nicht vollständig unter denselben Regeln betrieben. Änderungen am
Harness besitzen dadurch keinen durchgängigen, persistenten Self-Hosting-Run.
Außerdem endet die Automation derzeit nach einem ausgeführten Pull-Request-
Review: Ein Mensch muss Review-Threads manuell auslesen, ihre Relevanz
bewerten, einen Agenten zur Korrektur auffordern, Tests verfolgen und die
Threads beantworten und auflösen.

Diese Lücken erzeugen unnötiges Babysitting, uneinheitliche Audit-Evidence und
das Risiko doppelter oder rekursiver Agentenläufe.

Das Requirement konkretisiert
[Issue #35](https://github.com/munichdeveloper/pi-spec-harness/issues/35).

## Nutzer-Outcome

`munichdeveloper/pi-spec-harness` kann idempotent als eigenes Zielrepository
initialisiert und anschließend über die normale Harness-Kette weiterentwickelt
werden. Ein vertrauenswürdiges, abgeschlossenes Review mit neuen actionable
Threads startet für den exakt gebundenen PR und Head-SHA automatisch eine
kontrollierte Behebungsiteration. Der Agent implementiert innerhalb des
freigegebenen Scopes, weist die Änderung durch Tests und CI nach, beantwortet
jeden Thread und löst ihn erst unter den definierten Bedingungen auf.

Der Mensch wird im Normalfall nur noch für fachliche Konflikte, Scope-
Erweiterungen, Risiken, ausgeschöpfte Iterationen und Merge-Gates benötigt.

## Akzeptanzkriterien

- AC-01: Der Harness kann idempotent in
  `munichdeveloper/pi-spec-harness` als Zielrepository initialisiert und
  aktualisiert werden, ohne rekursive oder doppelte Bootstrap-Runs.
- AC-02: Self-Hosting verwendet ausschließlich einen bereits veröffentlichten
  vollständigen Commit-SHA oder unveränderlichen Release-Tag. Ein noch nicht
  gemergter Harness-Stand darf sich nicht selbst aktivieren.
- AC-03: Ein synthetischer Self-Hosting-Smoke-Run besitzt genau ein Tracking-
  Issue und durchläuft die normalen Gates bis zum nachgewiesenen Merge-Effekt.
- AC-04: Ein abgeschlossenes Review eines vertrauenswürdigen Reviewers mit
  mindestens einem neuen actionable Thread startet genau eine Behebungsiteration
  für den exakten PR und den geprüften Head-SHA.
- AC-05: Informationskommentare, veraltete oder bereits aufgelöste Threads,
  nicht vertrauenswürdige Reviewer und bereits verarbeitete Events erzeugen
  keine Implementierungsiteration.
- AC-06: Jeder Thread erhält eine persistente Klassifikation und eine
  auditierte Antwort, die Umsetzung oder begründete Nicht-Umsetzung beschreibt.
- AC-07: Threads werden erst nach nachgewiesener Umsetzung und grüner relevanter
  CI oder nach einer zulässigen, auditierten Nicht-Umsetzungsentscheidung
  aufgelöst. Konflikte und Scope-Erweiterungen bleiben offen.
- AC-08: Ein Agenten-Push bindet den neuen vollständigen Head-SHA, invalidiert
  ältere Review-/CI-Evidence und löst die erneute CI- und Review-Prüfung aus.
- AC-09: Doppelte Eventzustellung, Bot-eigene Antworten und Thread-Auflösungen
  erzeugen keine doppelten oder rekursiven Läufe.
- AC-10: Widersprüchliche Reviews, neue Produktentscheidungen, sensible
  Änderungen und höchstens drei fehlgeschlagene automatische Iterationen führen
  zu einem strukturierten Human Gate.
- AC-11: Alle Schritte werden mit Prozesskennung, Akteur, verwendeter Rolle,
  Zeitpunkt, Begründung, Beschreibung, PR und Head-SHA auditiert.
- AC-12: Self-Hosting, Event-Deduplizierung, Thread-Klassifikation, Iteration,
  Eskalation und Merge-Effekt sind durch Unit-, Workflow-Vertrags- und
  synthetische End-to-End-Tests abgedeckt.

## Nicht-Ziele

- automatisches Mergen ohne bestehende technische und menschliche Merge-Gates,
- eigenmächtige Erweiterung des freigegebenen Issue-/Spec-Scopes,
- Verarbeitung von Reviews ohne eindeutige Bindung an Run, PR und Head-SHA,
- unbegrenzte automatische Korrekturschleifen,
- kostenpflichtiger Fallback bei ausgeschöpften kostenlosen Kontingenten,
- zusätzliche Datenbank oder dauerhaftes Polling für Review-Zustand.

## Kostenrahmen

Die erste Ausbaustufe bleibt im bestehenden 0-Euro-Kostenrahmen. Sie verwendet
vorhandene GitHub-, Actions- und Copilot-Kontingente. Sind diese ausgeschöpft,
pausiert der Run mit `status:needs-human`; es wird kein kostenpflichtiger
Anbieter automatisch aktiviert.
