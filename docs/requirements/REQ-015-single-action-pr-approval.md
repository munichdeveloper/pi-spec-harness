---
id: REQ-015
type: requirement
title: Genau eine menschliche Aktion pro PR-Freigabe
status: approved
owner: product
risk: high
created: 2026-08-24
updated: 2026-08-24
---

# REQ-015: Genau eine menschliche Aktion pro PR-Freigabe

## Problem

Ein Mensch muss derzeit teilweise ein Approval-Label setzen und denselben PR
anschließend zusätzlich mergen. Beide Aktionen drücken dieselbe Freigabe aus
und erzeugen unnötiges Babysitting.

## Outcome

Der tatsächliche GitHub-Merge eines geschützten PRs ist die einzige
Gesamtfreigabe seines exakten Heads. Labels bleiben ausschließlich für echte
Entscheidungen ohne unmittelbaren PR-Merge bestehen.

## Akzeptanzkriterien

- AC-01: Spec- und Delivery-PRs benötigen nie Label plus manuellen Merge für dieselbe Entscheidung.
- AC-02: Ein manueller Merge auf geschützten `main` gilt als Entscheidung und bestätigter Effekt für den exakten Head-SHA.
- AC-03: Erforderliche Checks und offene Review-Findings blockieren den Merge über Repository Rulesets.
- AC-04: Agenten und Standard-Workflow-Tokens dürfen die menschliche Merge-Aktion nicht imitieren.
- AC-05: Nicht-PR-Entscheidungen verwenden weiterhin ausschließlich Human-Gate-Labels.
- AC-06: Merge-Event, Akteur, Rolle, Head, Merge-SHA und Schutzstatus werden auditiert.
- AC-07: Post-Merge-Verifikation, Dokumentation und Run-Abschluss laufen automatisch.
- AC-08: Ein Merge ohne vollständige Voraussetzungen erzeugt einen sichtbaren Compliance-Fehler, niemals stillen Erfolg.
- AC-09: Bestehende Runs und alte Label-Gates bleiben rückwärtskompatibel und migrierbar.
- AC-10: E2E belegt je genau eine menschliche Aktion für Spec- und Delivery-Freigabe.
