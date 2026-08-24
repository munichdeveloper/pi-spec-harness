---
id: REQ-014
type: requirement
title: Agent-generierte Software Spec aus einem freigegebenen Requirement
status: proposed
owner: product
risk: medium
created: 2026-08-24
updated: 2026-08-24
---

# REQ-014: Agent-generierte Software Spec aus einem freigegebenen Requirement

## Problem

Der reaktive Harness beginnt derzeit erst mit einer bereits vorhandenen und
freigegebenen Software Spec. Die Ausarbeitung zwischen Requirement und Spec
muss deshalb außerhalb der Factory erfolgen.

## Outcome

Ein auf dem Default-Branch freigegebenes Requirement erzeugt idempotent einen
Auftrag an einen konfigurierbaren Spec-Agenten (initial GitHub Copilot oder
Claude). Der Agent erstellt einen PR mit einer nachvollziehbaren Software Spec.
Der PR-Merge ist die einzige Freigabe der fertigen Spec; danach startet der
bestehende `spec-to-issue`-Pfad automatisch.

## Akzeptanzkriterien

- AC-01: Ein neues Requirement auf dem Default-Branch erzeugt höchstens einen Spec-Generierungsauftrag.
- AC-02: Der Provider ist konfigurierbar (`github-copilot` oder `claude-code`) und wird mit unveränderlichem Scope beauftragt.
- AC-03: Der Agent erstellt oder aktualisiert genau eine zu REQ-ID und Source-SHA gebundene Spec in einem PR.
- AC-04: Die Spec enthält Traceability, Entscheidungen, Risiken, offene Fragen und technische Akzeptanzkriterien.
- AC-05: Offene Produkt-, Kosten- oder Security-Fragen werden als Human-Gate sichtbar; sie werden nicht geraten.
- AC-06: Der Merge des Spec-PRs ist die einzige Gesamtfreigabe der Spec; kein zusätzliches Approval-Label ist nötig.
- AC-07: Erst eine auf dem Default-Branch gelandete Spec darf `spec-to-issue` auslösen.
- AC-08: Retries, Events und Providerwechsel erzeugen weder doppelte Specs noch doppelte PRs.
- AC-09: Auftrag, PR, Gates, Merge und Folgeaktion werden vollständig auditiert.
- AC-10: Ein E2E-Test belegt Requirement → Agent → Spec-PR → Merge → Implementierungs-Issue.

## Nicht-Ziele

- automatische Freigabe fachlicher Unklarheiten,
- Ausführung untrusted PR-Codes mit Write-Credentials,
- automatische Implementierung vor dem Spec-Merge.
