---
id: SPEC-013
type: software-spec
title: Vertrauenswürdige vollautomatische Review-Remediation
status: approved
owner: engineering
risk: high
requirements:
  - REQ-013
implementation_assignee: "@github-copilot"
created: 2026-08-23
updated: 2026-08-23
---

# SPEC-013: Vertrauenswürdige vollautomatische Review-Remediation

## Zusammenfassung

SPEC-013 schließt die auf PR #71 beobachtete Lücke. Ein vertrauenswürdiger
Default-Branch-Receiver klassifiziert Review-Ereignisse, prüft die kanonische
Run-/PR-Bindung und stößt exakt eine begrenzte Remediation an. PR-Code wird in
diesem Write-Kontext nie ausgeführt. Polling erfolgt eventgetrieben plus über den
bestehenden deterministischen Watchdog. Ein fehlender Run wird nicht mehr als
Erfolg verschluckt.

## Freizugebende Entscheidungen

1. **Scope:** Vollautomatische Remediation gilt nur für PRs mit kanonischem
   Run-Marker oder eindeutig gebundenem Implementierungs-Issue. Andere PRs
   werden sichtbar `unmanaged-blocked`; sie werden nicht mit erfundenen
   REQ-/SPEC-Werten auto-initialisiert.
2. **Trust Boundary:** Review-Ingestion erfolgt durch `pull_request_target` aus
   dem Default Branch. Der Job liest ausschließlich GitHub-Metadaten/API-Daten
   und checkt nur den immutable Harness-Release aus; niemals den PR-Head.
3. **Remediation:** Der bestehende Coding Agent wird über genau einen
   idempotenten Auftrag auf dem vorhandenen PR-Branch beauftragt. Die Action
   verändert Produktcode nicht selbst.
4. **Polling:** GitHub-Events sind der Primärtrigger. Ein deterministischer
   Watchdog reconciliert ausbleibende Agenten-/Check-Events nach 10 Minuten,
   höchstens dreimal; danach entsteht ein echtes Human-Gate.
5. **Merge:** Die Spec automatisiert Fortsetzung und Merge-Effekt-Verifikation,
   hebt aber eine konfigurierte menschliche Merge-Freigabe nicht auf.

## Architektur

### Trusted Review Receiver

Eine neue installierbare dünne Workflow-Referenz lauscht auf
`pull_request_target` (`review submitted`, relevante Issue-Comments und
Synchronisation). Sie verwendet ausschließlich die Workflow-Version von
`main`. Berechtigungen sind jobweise minimal (`contents: read`, `issues: write`,
`pull-requests: write`, optional `actions: write` nur für den begrenzten
Remediation-Dispatch). Fork-PRs und PRs ohne eindeutigen Harness-Kontext werden
nicht mit Write-Aktionen auf dem PR-Branch bearbeitet.

### Bindungs-Preflight

Neue reine Entscheidung `classifyReviewAutomationScope(pr, candidateRuns)` mit
den Ergebnissen `managed`, `recoverable-binding`, `unmanaged-blocked` und
`ambiguous-blocked`. `recoverable-binding` darf nur eine bereits kanonisch im
Run gebundene Implementierungs-Issue-Beziehung reparieren. Fehlen Run oder
eindeutige Evidenz, publiziert der Adapter Label, Kommentar, Audit und einen
fehlgeschlagenen Check statt `success`.

### Remediation-Paket und Zustand

`RunState` erhält einen append-only Review-Dispatch-Checkpoint aus Review-ID,
Thread-Keys, PR-Head-SHA, Auftragstimestamp und Status. Der Idempotenzschlüssel
bindet Repository, PR, Head-SHA und sortierte Thread-Keys. Erst nach
persistiertem Checkpoint wird der Coding Agent beauftragt. Ein Restart erkennt
`prepared`/`dispatched` und reconciliert statt doppelt zu beauftragen.

### Abschluss

Nach Agenten-Commit invalidiert der neue Head alte Check-Evidenz. Grüne Checks
plus Commit-/Testnachweis erlauben Antworten und Thread-Auflösung. Danach ruft
der Orchestrator den bestehenden Merge-Pfad auf. Offene Findings bleiben eine
harte State-Machine-Barriere.

## Technische Akzeptanzkriterien

- TAC-01: Scope-Klassifikation ist rein und deckt managed, reparierbar,
  unmanaged und mehrdeutig ab.
- TAC-02: `unmanaged-blocked` erzeugt einen fehlgeschlagenen neutralen Check,
  sichtbares Label/Kommentar und Audit; kein Erfolgs-Skip.
- TAC-03: Workflow-Contract belegt `pull_request_target` und dass weder
  `github.event.pull_request.head.sha` ausgecheckt noch PR-Skripte ausgeführt
  werden.
- TAC-04: Managed Reviews erzeugen genau einen persistierten Dispatch-Checkpoint
  und genau einen Agentenauftrag.
- TAC-05: Doppelte Review-, Kommentar- und Synchronize-Events bleiben No-op.
- TAC-06: Crash zwischen Checkpoint und GitHub-Schreibaktion wird ohne
  Doppelauftrag reconciled.
- TAC-07: Head-SHA-Wechsel invalidiert alte CI-Evidenz, nicht aber die Historie.
- TAC-08: Thread-Auflösung erfordert grünen aktuellen Head und
  Commit-/Testevidenz.
- TAC-09: Der Watchdog reconciliert nach 10 Minuten höchstens dreimal und öffnet
  danach genau ein Human-Gate.
- TAC-10: Ein synthetischer E2E-Lauf validiert den vollständigen Pfad ohne
  manuelle Workflow-Freigabe.
- TAC-11: Audit deckt Dispatch, Block, Retry, Thread-Auflösung und Fortsetzung ab.
- TAC-12: Dokumentation beschreibt Trust Boundary, Recovery und Human-Gates.

## Verifikation

- `npm run check`,
- Unit-Tests für Scope und Idempotenz,
- Workflow-Vertragstests für Berechtigungen und verbotenen PR-Head-Checkout,
- Restart-/Concurrency-Tests,
- synthetischer Self-Hosting-E2E auf einem bewusst erzeugten Finding.

## Rollout

1. REQ-013/SPEC-013 freigeben und mergen.
2. Issue #72 mit `harness:approved-for-agent` markieren; v0.2.4 erzeugt und
   bindet den Implementierungs-Run und beauftragt Copilot.
3. Implementierungs-PR erstmals vollständig durch die neue Automation führen.
4. Erst nach Self-Hosting-Nachweis die installierbare Referenz in Zielrepos
   ausrollen.

## Rollback

Die trusted Review-Referenz kann einzeln deaktiviert und auf den bisherigen
`pull_request_review`-Receiver zurückgepinnt werden. Persistierte Checkpoints und
Audit-Historie bleiben erhalten; offene Runs werden nicht gelöscht.
