---
id: SPEC-015
type: software-spec
title: Merge-as-Approval für geschützte Pull Requests
status: proposed
owner: engineering
risk: high
requirements:
  - REQ-015
implementation_assignee: "@github-copilot"
created: 2026-08-24
updated: 2026-08-24
---

# SPEC-015: Merge-as-Approval für geschützte Pull Requests

## Architektur

RunState erhält eine explizite Approval-Policy pro PR-Artefakt:
`merge-is-approval` oder rückwärtskompatibel `label-authorizes-auto-merge`.
Für neue Harness-Runs ist `merge-is-approval` Standard. Ein trusted
`pull_request.closed`-Receiver verifiziert über GitHub API den gebundenen
PR, den vor dem Merge geprüften Head, den menschlichen Merge-Akteur, Merge-SHA
und Ruleset-/Check-Evidenz. Erst danach persistiert er Entscheidung und Effekt
transaktional und startet Post-Merge-Schritte.

## Technische Entscheidungen

1. Keine Interpretation von Kommentaren oder Review-Approvals als Merge-Freigabe.
2. `merged == true` plus exakte Bindung ist die einzige Entscheidungsevidenz.
3. Bots/Apps sind als Merge-Akteure abgelehnt, außer eine separate Policy wurde
   über ein eigenes Security-Gate freigegeben.
4. Rulesets schützen `main`: erforderliche CI, keine offenen Findings, kein
   direkter Push. Settings-Mutationen laufen nur über ein SHA-/Werte-gebundenes
   Human-Gate mit Rollback.
5. Entscheidung und Merge-Effekt werden in einem idempotenten Checkpoint
   persistiert; Crash-Recovery adoptiert einen bereits gelandeten Merge.
6. Labels bleiben für Entscheidungen ohne Merge-Effekt und für Legacy-Runs.

## Technische Akzeptanzkriterien

- TAC-01: State-Machine verlangt bei `merge-is-approval` kein Approval-Label.
- TAC-02: Ein offener oder geschlossener, aber ungemergter PR gilt nie als freigegeben.
- TAC-03: PR, erwarteter Head und GitHub-Merge-Evidenz müssen exakt übereinstimmen.
- TAC-04: Bot-/App-Merges werden standardmäßig blockiert und auditiert.
- TAC-05: Persistenz ist idempotent und crash-sicher; Events erzeugen keine doppelte Entscheidung.
- TAC-06: Post-Merge-Dokumentation startet ohne Chat und schließt den Run erst nach Bestätigung.
- TAC-07: Legacy-Policy funktioniert unverändert und ist explizit migrierbar.
- TAC-08: Contract-Test prüft minimale Rechte sowie Checks-/Status-Read.
- TAC-09: Process Audit dokumentiert Human Actor, Access Role, Head, Merge-SHA, Grund und Outcome.
- TAC-10: Synthetisches E2E beweist eine menschliche Aktion pro PR-Freigabe.

## Rollback

Neue Runs können auf `label-authorizes-auto-merge` zurückgestellt werden.
Bereits persistierte Merge-Evidenz bleibt unverändert; kein Merge wird
rückgängig gemacht.
