---
id: SPEC-014
type: software-spec
title: Requirement-to-Spec Agent Pipeline
status: proposed
owner: engineering
risk: medium
requirements:
  - REQ-014
implementation_assignee: "@github-copilot"
created: 2026-08-24
updated: 2026-08-24
---

# SPEC-014: Requirement-to-Spec Agent Pipeline

## Architektur

Ein neuer installierbarer Katalogeintrag `requirement-to-spec` beobachtet
gemergte Dateien unter `docs/requirements/**/*.md`. Ein vertrauenswürdiger
reusable Workflow validiert Frontmatter und Source-SHA, berechnet den stabilen
Schlüssel `<repository>:<REQ-ID>:<source-sha>` und materialisiert genau einen
Spec-Auftrag. Der Auftrag enthält Zielpfad, Pflichtabschnitte, Provider und
Branch. Provideradapter delegieren an GitHub Copilot Coding Agent oder die
gepinnt konfigurierte Claude Code Action.

Der Agent-PR enthält `status: approved`; dieser Wert ist außerhalb des
Default-Branches nicht wirksam. Der bestehende `spec-to-issue`-Workflow reagiert
erst auf den Merge. Damit ist der Merge selbst die einzige Spec-Freigabe.

## Technische Entscheidungen

1. Neue reine Klassifikation `classifyRequirementForSpecGeneration` mit
   `eligible`, `already-dispatched`, `already-materialized`, `blocked`.
2. Persistente Outbox im zugehörigen Run-State; GitHub Writes verwenden
   Read-before-write und Read-after-unknown.
3. Der Agentenauftrag arbeitet auf einem dedizierten Branch und darf nur den
   festgelegten Spec-Pfad plus unmittelbar zugehörige Dokumentation ändern.
4. Offene Entscheidungen öffnen dasselbe persistente Run-Issue als Human-Gate.
5. Der Spec-PR-Merge wird als `SPEC_APPROVAL` und Merge-Effekt gemeinsam
   auditiert; ein Approval-Label für denselben Gesamtentscheid ist verboten.
6. Reusable Workflow und dünne Referenz laufen ausschließlich aus gepinntem
   Harness-Code; kein PR-Head-Checkout mit Write-Token.

## Technische Akzeptanzkriterien

- TAC-01: Parser und Klassifikation sind rein und testen alle Frontmatter-/Statusfälle.
- TAC-02: Gleiche REQ-ID und Source-SHA erzeugen einen Auftrag und einen PR.
- TAC-03: Ein neuer Requirement-SHA invalidiert nur nicht gemergte alte Entwürfe und bleibt nachvollziehbar.
- TAC-04: Copilot- und Claude-Adapter erfüllen denselben Dispatch-Vertrag.
- TAC-05: Pflichtabschnitte und REQ-Traceability werden vor PR-Erstellung validiert.
- TAC-06: Ein Spec-PR-Merge benötigt kein zusätzliches Gate-Label.
- TAC-07: Nicht gemergte Specs lösen niemals `spec-to-issue` aus.
- TAC-08: Managed Marker und Workflow-Katalog unterstützen create/noop/update/conflict.
- TAC-09: Audit enthält Actor, Access Role, Provider, REQ/SPEC, Source-SHA, PR und Outcome.
- TAC-10: Synthetisches E2E deckt beide Providerpfade mindestens per Contract, einen Provider real ab.

## Rollback

Die installierte Referenz wird deaktiviert oder auf den vorigen Pin gesetzt.
Outbox, Run-State und erzeugte PRs bleiben erhalten; nichts wird gelöscht.
