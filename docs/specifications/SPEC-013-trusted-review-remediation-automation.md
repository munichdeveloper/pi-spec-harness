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

1. **Scope:** Vollautomatische Remediation gilt nur für PRs, deren Repository,
   PR-Nummer und gebundener Head-SHA im persistierten Run übereinstimmen. Der
   vom PR-Autor kontrollierbare Body-Marker ist lediglich ein Suchhinweis und
   niemals Vertrauensanker. Eine eindeutig gebundene Implementierungs-Issue-
   Beziehung ist nur ein kontrollierter Recovery-Pfad. Andere PRs
   werden sichtbar `unmanaged-blocked`; sie werden nicht mit erfundenen
   REQ-/SPEC-Werten auto-initialisiert.
2. **Trust Boundary:** Review-Ingestion erfolgt über getrennte GitHub-Trigger
   aus dem Default Branch. Der Job liest ausschließlich Metadaten/API-Daten und
   delegiert an einen mit vollständigem Commit-SHA oder immutablem Release-Tag
   gepinnten Harness-Workflow; niemals an Code vom PR-Head.
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

Der bestehende Katalogeintrag `review-fix` wird am selben Zielpfad
`.github/workflows/harness-review-fix.yml` ersetzt; es entsteht kein zweiter
Review-Receiver. Sein Managed Marker bleibt erhalten, sein Default-Ref wird auf
den neuen unveränderlichen Release-Tag gesetzt, Renderer und `harness install
review-fix --ref <full-sha-or-release-tag>` aktualisieren denselben Pfad. Ein
Vertragstest prüft Katalogname, Zielpfad, Marker, Pin, Renderer und Install-
Kommando sowie, dass alte und neue Receiver nicht gleichzeitig aktiv sein
können.

Die dünne Referenz definiert getrennte Trigger für `pull_request_review`
(`submitted`), `issue_comment` (`created`/`edited`) und `pull_request_target`
(`opened`/`synchronize`/`reopened`). Jeder Trigger lädt nur den vertrauenswürdigen
Default-Branch-Workflow; die delegierte wiederverwendbare Workflow-Referenz ist
auf ein vollständiges Commit-SHA oder einen immutablem Release-Tag gepinnt.
Berechtigungen sind jobweise minimal: `contents: read`, `issues: write`,
`pull-requests: write`, `checks: write`; `actions: write` nur, falls die konkrete
Dispatch-API es verlangt. Die zentrale SPEC-005-Audit-Zustellung läuft in einem
separaten Recorder-Job mit eigenem, eng begrenztem Secret/Token und
`contents: write` ausschließlich im Audit-Zielrepository. Fork-PRs und PRs ohne
eindeutigen Harness-Kontext erhalten keine Write-Aktion auf ihrem Branch.

Vor Aktivierung wird der schreibende `bind-implementation-pr`-Pfad in
`harness-gate-trigger.yml` auf denselben trusted Adapter umgestellt oder
deaktiviert. Ein Migrationstest erzwingt genau einen autoritativen Bindungs- und
Review-Pfad.

### Bindungs-Preflight

Neue reine Entscheidung `classifyReviewAutomationScope(pr, candidateRuns)` mit
den Ergebnissen `managed`, `recoverable-binding`, `unmanaged-blocked` und
`ambiguous-blocked`. `managed` erfordert die exakte Übereinstimmung von
Repository, PR-Nummer und aktuellem Head-SHA mit dem persistierten Run; ein
Body-Marker allein reicht nie. `recoverable-binding` darf nur eine bereits
kanonisch im Run gebundene Implementierungs-Issue-Beziehung reparieren. Fehlen
Run oder eindeutige Evidenz, publiziert der Adapter Label, Kommentar, Audit und
einen Check mit `conclusion: failure` und stabilem Recovery-Code
`HARNESS_REVIEW_BINDING_REQUIRED` statt `success`.

Für den No-Run-Fall gilt eine deterministische PR-Prozesskennung
`review-remediation:<owner>/<repo>:pr:<number>:head:<sha>`. Blockzustand,
Recovery-Code, letzter Event-Key und Audit-Zustellstatus werden idempotent in
einem verwalteten PR-Kommentar plus Check Run gespeichert. Damit existieren
auch ohne erfundenen Run eine persistente Retry-Identität und Korrelation.

### Remediation-Paket und Zustand

`RunState` erhält eine persistente Outbox mit Review-ID, Thread-Keys,
PR-Head-SHA, Auftragstimestamp, Provider-Auftrags-ID und Status. Der
Idempotenzschlüssel bindet Repository, PR, Head-SHA und sortierte Thread-Keys.
Der konkrete Agentenauftrag ist genau ein verwalteter `@copilot`-Kommentar auf
dem bestehenden PR; sein unveränderlicher Marker enthält den Idempotenzschlüssel
und verlangt Änderungen ausschließlich auf dem bereits gebundenen Head-Branch.
Vor einem Write sucht der Adapter nach diesem Marker, nach dem Write liest er
Kommentar-ID und Branchbindung zurück und bestätigt beides in der Outbox.
GitHubs Kommentar-API bietet keine providerseitige Idempotenz: deshalb gilt
explizit at-least-once Zustellung mit deduplizierendem Marker/Read-before-write
und Recovery-Read-after-unknown. Ein Restart reconciliert `prepared`, `sent` und
`confirmed`; er schreibt nur, wenn weder Kommentar noch Provider-ID existieren.

### Abschluss

Nach Agenten-Commit invalidiert der neue Head alte Check-Evidenz. Grüne Checks
plus Commit-/Testnachweis erlauben Antworten und Thread-Auflösung. Danach ruft
der Orchestrator den bestehenden Merge-Pfad auf. Offene Findings bleiben eine
harte State-Machine-Barriere.

## Technische Akzeptanzkriterien

- TAC-01: Scope-Klassifikation ist rein und deckt managed, reparierbar,
  unmanaged und mehrdeutig ab.
- TAC-02: `unmanaged-blocked` erzeugt einen Check mit `conclusion: failure`,
  Recovery-Code `HARNESS_REVIEW_BINDING_REQUIRED`, sichtbares Label/Kommentar
  und Audit; kein Erfolgs-Skip.
- TAC-03: Workflow-Contract belegt die getrennten trusted Trigger und dass weder
  `github.event.pull_request.head.sha` ausgecheckt noch PR-Skripte ausgeführt
  werden.
- TAC-04: Managed Reviews erzeugen eine persistente Outbox und durch
  Marker-Deduplizierung genau einen wirksamen Agentenauftrag auf dem bestehenden
  PR-Branch.
- TAC-05: Doppelte Review-, Kommentar- und Synchronize-Events bleiben No-op.
- TAC-06: Crash vor, während oder nach der GitHub-Schreibaktion wird über
  Outbox, Marker-Suche und Read-after-unknown ohne zweiten wirksamen Auftrag
  reconciled.
- TAC-07: Head-SHA-Wechsel invalidiert alte CI-Evidenz, nicht aber die Historie.
- TAC-08: Thread-Auflösung erfordert grünen aktuellen Head und
  Commit-/Testevidenz.
- TAC-09: Ein eigener Action-Key `review-remediation-dispatch` verwendet einen
  Review-Stale-Schwellwert von 10 Minuten und wird durch einen separaten
  10-Minuten-Schedule reconciled; die SPEC-011-Defaults 45/30 Minuten bleiben
  unverändert. Nach höchstens drei Versuchen öffnet er genau ein Human-Gate.
- TAC-10: Ein synthetischer E2E-Lauf validiert den vollständigen Pfad ohne
  manuelle Workflow-Freigabe.
- TAC-11: Audit deckt Dispatch, Block, Retry, Skip, Thread-Auflösung,
  Fortsetzung und Abschluss gemäß folgender verbindlicher Zuordnung ab.
- TAC-12: Dokumentation beschreibt Trust Boundary, Recovery und Human-Gates.
- TAC-13: Der Katalogvertrag für `review-fix` prüft Zielpfad, Managed Marker,
  unveränderlichen Default-Pin, Renderer, Install-Kommando und gegenseitigen Ausschluss
  mit dem alten Receiver.

### Audit-Zuordnung

| Ereignis | Process code | Outcome | Idempotenz/Korrelation | Evidenz |
| --- | --- | --- | --- | --- |
| Auftrag bestätigt | `AI_IMPLEMENTATION_DISPATCH` | `dispatched` | Dispatch-Key, Run-ID, PR, Head, Provider-ID | Outbox + Kommentar |
| Bindung blockiert | `PROCESS_BLOCK` | `unmanaged-blocked` / `ambiguous-blocked` | PR-Prozesskennung + Head | Failure-Check + Recovery-Code |
| Watchdog-Retry | `PROCESS_RETRY` | `retrying` / `exhausted` | Run/PR + Action-Key + Versuch | Run-State + Workflow-Run |
| Idempotenter Skip | `PROCESS_SKIP` | `duplicate` / `informational` | Event-Key + Dispatch-Key | Outbox/No-op-Entscheid |
| Thread gelöst | `REVIEW_FINDING_RESOLVE` | `resolved` | Thread-ID + geprüfter Head | Thread + Check-/Testevidenz |
| Run fortgesetzt | `RUN_RESUME` | `continued` | Run-ID + State-Revision | Run-State-Transition |
| Remediation fertig | `AI_IMPLEMENTATION_COMPLETE` | `completed` | Dispatch-Key + finaler Head | Commit, Checks, geschlossene Threads |

Jedes Envelope enthält Zeitpunkt, Process Code, Actor, Access Role, Begründung,
Beschreibung, Repository, PR, Head-SHA sowie Run-ID oder deterministische
PR-Prozesskennung. Der zentrale Recorder verwendet denselben Idempotenzschlüssel
für Wiederholungen und bestätigt die Zustellung im Run/PR-Zustand.

## Verifikation

- `npm run check`,
- Unit-Tests für Scope und Idempotenz,
- Workflow-Vertragstests für Berechtigungen und verbotenen PR-Head-Checkout,
- Restart-/Concurrency-Tests,
- synthetischer Self-Hosting-E2E auf einem bewusst erzeugten Finding.

## Rollout

1. REQ-013/SPEC-013 freigeben und mergen.
2. Aus SPEC-013 ein separates Implementierungs-Issue mit `SPEC-013` im Titel und
   expliziten `REQ-013`-/`SPEC-013`-Referenzen im Body erzeugen. Erst dieses
   Issue erhält `harness:approved-for-agent`, damit v0.2.4 Run-Bootstrap und
   Copilot-Zuweisung deterministisch ausführt; Issue #72 bleibt das Parent-Issue.
3. Implementierungs-PR erstmals vollständig durch die neue Automation führen.
4. Erst nach Self-Hosting-Nachweis die installierbare Referenz in Zielrepos
   ausrollen.

## Rollback

Die neue Referenz ersetzt den bestehenden `review-fix`-Zielpfad atomar. Rollback
pinnt genau diesen Pfad auf die vorige immutable Version zurück; niemals werden
alter und neuer Receiver parallel aktiviert. Persistierte Outbox und
Audit-Historie bleiben erhalten; offene Runs werden nicht gelöscht.
