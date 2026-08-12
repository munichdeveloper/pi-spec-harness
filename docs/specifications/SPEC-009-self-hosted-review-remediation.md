---
id: SPEC-009
type: software-spec
title: Self-hosted Harness und automatische Behebung von Review-Kommentaren
status: approved
owner: engineering
risk: medium
requirements:
  - REQ-009
implementation_assignee: "@github-copilot"
created: 2026-08-12
updated: 2026-08-12
---

# SPEC-009: Self-hosted Harness und automatische Behebung von Review-Kommentaren

## Zusammenfassung

Der Harness wird selbst als Zielrepository initialisiert und erhält einen
reaktiven Review-Fix-Zyklus. Ein vollständig eingereichtes, vertrauenswürdiges
Review wird für den exakt gebundenen PR und Head-SHA als Paket verarbeitet.
Nur neue actionable Threads erzeugen eine automatische Iteration. Der
Implementierungsagent arbeitet auf dem vorhandenen PR-Branch, weist seine
Änderungen durch Tests und neue SHA-gebundene Evidence nach, beantwortet jeden
Thread und löst ihn kontrolliert auf.

Die Spec implementiert REQ-009 und
[Issue #35](https://github.com/munichdeveloper/pi-spec-harness/issues/35).
Sie übernimmt die neun am 12. August 2026 freigegebenen Entscheidungen unter
dem bestehenden 0-Euro-Kostenrahmen.

## Technische Entscheidungen

### 1. Eventvertrag

- `pull_request_review.submitted` ist der einzige Event, der bei mindestens
  einem neuen actionable Thread eine Implementierungsiteration starten darf.
- `pull_request_review_thread.resolved` und
  `pull_request_review_thread.unresolved` synchronisieren nur Threadzustand.
  `pull_request_review_thread.unresolved` darf erst bei einem noch nicht verarbeiteten
  Thread/SHA-Schlüssel eine spätere Prüfung ermöglichen.
- `pull_request.synchronize` bindet keinen Run implizit neu, sondern
  invalidiert alte Review-/CI-Evidence für den zuvor gebundenen SHA und stößt
  die erneute technische Prüfung des explizit gebundenen PRs an.
- Reine PR-Kommentare und Review-Zusammenfassungen ohne Inline-Thread starten
  keine Implementierung.
- Eine Concurrency-Gruppe aus Repository, Run und PR serialisiert Events;
  `cancel-in-progress: false` verhindert überholende Seiteneffekte.

### 2. Vertrauensmodell

- Apps und Bots müssen in `HARNESS_TRUSTED_REVIEW_ACTORS` explizit erlaubt
  sein. Initialer Wert für Referenzrepositories ist GitHub Copilot.
- Menschen benötigen zum Eventzeitpunkt mindestens `write`-Berechtigung im
  Repository.
- Der aktuell ausführende Implementierungsagent, unbekannte Apps und externe
  Nutzer ohne Schreibrecht dürfen keine Iteration starten.
- Actor-ID beziehungsweise App-Slug, Berechtigungsnachweis, Review-ID und
  Head-SHA werden auditiert.
- Mehrere vertrauenswürdige, aber widersprüchliche Reviews öffnen ein Human
  Gate; der Agent bevorzugt keinen Reviewer eigenmächtig.

### 3. Persistenter Review-Zustand

Der kanonische Zustand lebt im bestehenden Tracking-Issue des Runs. Das
Run-State-Schema erhält eine versionierte Review-Sektion mit mindestens:

- Repository, PR-Nummer und vollständigem geprüften Head-SHA,
- Review-ID, Reviewer, Reviewer-Typ und Zeitpunkt,
- Thread-ID und Klassifikation,
- Verarbeitungsstatus und Iterationsnummer,
- resultierendem Commit-SHA,
- Test-/CI-Evidence,
- Antwort- und Auflösungsstatus.

Zulässige Thread-Status sind `pending`, `informational`, `actionable`,
`implementing`, `implemented`, `declined`, `conflicting`, `needs-human`,
`outdated` und `resolved`. Der Idempotenzschlüssel lautet:

```text
repository + pullRequest + reviewId + threadId + reviewedHeadSha
```

Workflow-Artefakte dürfen ergänzende Logs enthalten, sind aber nicht
kanonisch. Fehlen Tracking-Issue, eindeutige PR-Bindung oder SHA-Übereinstimmung,
erfolgt keine Mutation.

### 4. Review-Pakete und Konflikte

- Alle beim Start vorhandenen kompatiblen actionable Threads desselben
  Head-SHA bilden genau ein Review-Paket und eine Iteration.
- Während der Implementierung eintreffende Threads werden einem späteren
  Paket zugeordnet.
- Inhaltlich überlappende Threads dürfen gemeinsam implementiert werden,
  bleiben im Audit aber einzeln referenziert.
- Widersprüche, Spec-/Issue-Konflikte, neue Produktentscheidungen, Auth-,
  Berechtigungs-, Secret-, Kosten- oder destruktive Änderungen öffnen ein
  Human Gate mit Threads, Alternativen und Auswirkungen.

### 5. Self-Hosting und Bootstrap

- Ein bereits veröffentlichter Harness-Ref initialisiert
  `munichdeveloper/pi-spec-harness` über einen normalen PR als Zielrepository.
- Source- und Target-Repository dürfen identisch sein. Die Installation
  erkennt diesen Zustand explizit und verwendet niemals den ungemergten
  Branch als reusable Workflow-Ref.
- Erst der Merge des Installations-/Upgrade-PRs aktiviert einen neuen
  vollständigen SHA oder unveränderlichen Release-Tag.
- Spätere Self-Hosting-Upgrades werden vom zuletzt aktiven Harness-Ref
  orchestriert und ebenfalls ausschließlich per PR ausgeliefert.
- Ein eindeutiger Bootstrap-/Upgrade-Identifier und eine repositoryweite
  Concurrency-Gruppe erlauben höchstens ein aktives Self-Hosting-Upgrade.
- Ein fehlgeschlagener Bootstrap lässt den zuletzt funktionierenden Ref aktiv.
- Ein synthetischer Smoke-Run prüft Tracking-Issue, Gates, Review-Zyklus und
  nachgewiesenen Merge-Effekt.

### 6. Schleifenschutz

- Pro PR und Head-SHA existiert höchstens eine aktive Review-Iteration.
- Ein neuer Head-SHA allein startet keine weitere Implementierung. Er benötigt
  abgeschlossene CI, ein neues vertrauenswürdiges Review und mindestens einen
  neuen actionable Thread.
- Antworten und Auflösungen durch den Agenten sowie identische bereits
  verarbeitete Review-/Thread-/SHA-Schlüssel sind No-ops.
- Ein persistenter Loop-Counter ergänzt das bestehende Limit von höchstens drei
  fehlgeschlagenen automatischen Iterationen; danach ist ein Human Gate
  verpflichtend.
- Abbruch und Retry verwenden den vorhandenen persistenten Zustand und starten
  nicht stillschweigend von vorne.

### 7. Implementierungsagent

- `HARNESS_REVIEW_FIX_AGENT` wählt den Anbieter. Zulässige initiale Werte sind
  `github-copilot` und `claude-code`; Standard ist `github-copilot`.
- Es gibt keinen automatischen Anbieterwechsel. Fehlende Credentials oder
  Anbieterfehler erhalten begrenzte technische Retries und danach
  `status:needs-human`; sie zählen nicht ohne fachlichen Versuch als
  fehlgeschlagene Implementierungsiteration.
- Der Agent arbeitet ausschließlich auf dem bereits gebundenen PR-Branch und
  erhält Issue, Spec, Run-State, aktuellen Diff und Review-Paket.
- Bei vorhandenem PR darf er keinen zweiten PR erzeugen und den Scope nicht
  erweitern.
- Anbieter, Agentenaktion, GitHub-Rolle, PR und SHA werden auditiert.

### 8. Thread-Lifecycle

Für jeden Thread gilt die Reihenfolge Klassifikation, Implementierung oder
begründete Nicht-Umsetzung, lokale Verifikation, Push, grüne relevante CI,
Antwort und erst danach Auflösung.

- `informational`, bereits erledigt oder nachweislich sachlich falsch dürfen mit
  überprüfbarer Begründung beantwortet und aufgelöst werden.
- `conflicting`, scope-erweiternd oder technisch blockiert bleibt offen und
  erzeugt ein Human Gate beziehungsweise `status:needs-human`.
- Veraltete Threads werden als `outdated` auditiert und erzwingen keine
  Codeänderung.
- Wiederöffnen startet nur für den aktuellen Head-SHA und erneute actionable
  Klassifikation eine neue Iteration.

### 9. Risiko, Kosten und Merge

- Die Risikoklasse ist `medium`; die Implementierung bleibt im bestehenden
  0-Euro-Kostenrahmen und verwendet keine zusätzliche Datenbank, Queue oder
  Polling-Infrastruktur.
- Self-Hosting-Änderungen sowie Auth-, Berechtigungs-, Secret- und
  Workflow-Permission-Änderungen benötigen immer ein menschliches Merge-Gate.
- Review-Fixes erben ansonsten die Risikoklasse des ursprünglichen Runs.
- Grüne CI und aufgelöste Threads sind keine automatische Merge-Erlaubnis.
  `complete` wird erst nach dem nachgewiesenen Merge-Effekt erreicht.
- Bei ausgeschöpften kostenlosen Kontingenten pausiert der Run mit
  `status:needs-human`.

## Technische Akzeptanzkriterien

- `ISSUE-035/TAC-01`: `harness init` kann den Harness idempotent im Repository
  `munichdeveloper/pi-spec-harness` als Ziel initialisieren und aktualisieren.
- `ISSUE-035/TAC-02`: Self-Hosting verwendet nur einen bereits veröffentlichten
  unveränderlichen Ref und verhindert rekursive Bootstrap-Runs.
- `ISSUE-035/TAC-03`: Ein synthetischer Self-Hosting-Smoke-Run besitzt genau
  ein Tracking-Issue und erreicht erst nach nachgewiesenem Merge-Effekt
  `complete`.
- `ISSUE-035/TAC-04`: Ein vertrauenswürdiges abgeschlossenes Review mit neuem
  actionable Thread startet genau eine Iteration für den exakten PR/Head-SHA.
- `ISSUE-035/TAC-05`: Informationskommentare, veraltete/aufgelöste Threads,
  nicht vertrauenswürdige Reviewer und Duplikat-Events starten keine Iteration.
- `ISSUE-035/TAC-06`: Jeder Thread besitzt auditierte Klassifikation, Antwort
  und Umsetzungs- oder Nicht-Umsetzungsbegründung.
- `ISSUE-035/TAC-07`: Auflösung erfolgt nur nach grüner relevanter CI und
  zulässiger Entscheidung; Konflikt-/Gate-Threads bleiben offen.
- `ISSUE-035/TAC-08`: Ein Push bindet den neuen SHA und invalidiert alle alten
  SHA-gebundenen Review-/CI-Nachweise.
- `ISSUE-035/TAC-09`: Event-Duplikate, Bot-eigene Folgeereignisse und derselbe
  Idempotenzschlüssel sind No-ops und erzeugen keine Rekursion.
- `ISSUE-035/TAC-10`: Widerspruch, Scope-Erweiterung, sensible Änderung oder
  Iterationslimit öffnet ein strukturiertes Human Gate.
- `ISSUE-035/TAC-11`: Prozess-Audit enthält Zeitpunkt, Prozesskennung, Akteur,
  verwendete Rolle, Begründung, Beschreibung, Run, PR und Head-SHA.
- `ISSUE-035/TAC-12`: Unit-, Workflow-Vertrags- und synthetische E2E-Tests
  decken Self-Hosting, Deduplizierung, Klassifikation, Iteration, Eskalation
  und Merge-Effekt ab.

## Verifikation

- `npm run check`,
- State-Machine- und Schema-Tests für Review-Pakete und Idempotenzschlüssel,
- Workflow-Vertragstests für Events, Actor-Prüfung, Concurrency und
  Berechtigungen,
- Fixtures für actionable, informational, outdated, conflicting und
  wiedereröffnete Threads,
- Tests für fehlende Run-/PR-/SHA-Bindung und mehrfache Eventzustellung,
- synthetischer Review-Fix-Lauf mit neuem SHA, grüner CI, Antwort und
  Thread-Auflösung,
- synthetischer Konflikt- und Iterationslimit-Lauf mit Human Gate,
- Self-Hosting-Smoke-Run gegen veröffentlichten unveränderlichen Harness-Ref.

## Rollout

1. SPEC-009 und REQ-009 nach menschlicher Freigabe mergen.
2. Implementierungs-Issue #35 mit `status:ready` und `ai:allowed` aktivieren.
3. Review-State und auditierbare GitHub-Funktionen implementieren.
4. Reusable Review-Workflow und installierbare Referenz ergänzen.
5. Self-Hosting über den zuletzt veröffentlichten funktionierenden Harness-Ref
   in einem separaten Rollout-PR aktivieren.
6. Synthetischen Self-Hosting-/Review-Smoke-Run durchführen.

## Rollback

Die Review-Automation wird über eine benannte installierbare Workflowreferenz
aktiviert und kann durch Entfernen dieser Referenz deaktiviert werden. Ein
fehlgeschlagenes Self-Hosting-Upgrade ändert den aktiven gepinnten Ref nicht.
Persistenter Review-State und Audit bleiben zur Nachvollziehbarkeit erhalten;
offene Review-Fixes werden auf `needs-human` gesetzt und nicht automatisch
gemergt.

## Nicht-Ziele

- automatisches Mergen außerhalb bestehender Merge-/Human-Gates,
- Reviews für nicht gebundene PRs oder ohne Tracking-Issue,
- eigenmächtige Scope- oder Produktentscheidungen,
- mehr als drei fehlgeschlagene automatische Iterationen,
- kostenpflichtiger Anbieter-Fallback,
- Migration bestehender Zielrepositories als undokumentierter Nebeneffekt.
