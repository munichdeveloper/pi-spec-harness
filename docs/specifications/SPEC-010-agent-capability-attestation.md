---
id: SPEC-010
type: software-spec
title: Fingerprint-gebundener Bash-/Write-/Edit-Capability-Smoke
status: review
owner: engineering
risk: high
requirements:
  - REQ-010
source_issue: 28
implementation_assignee: "@github-copilot"
created: 2026-08-13
updated: 2026-08-13
---

# SPEC-010: Fingerprint-gebundener Bash-/Write-/Edit-Capability-Smoke

## Zusammenfassung

Der Harness erhält einen zentralen reusable Capability-Workflow und einen
installierbaren dünnen Caller. Im Zielrepository beweist ein realer
`claude-code-action`-Lauf anhand synthetischer Marker, dass Bash, Write und Edit
unter der dort wirksamen Credential- und Berechtigungskonfiguration ausführbar
sind. Nur ein deterministisch validierter Lauf erzeugt eine Fingerprint-gebundene
Cache-Attestation. Die Bug-Pipeline verlangt diesen Nachweis und erzeugt ihn bei
Bedarf automatisch, bevor der produktive Agent startet.

## Freigegebene technische Entscheidungen

1. Der Smoke läuft bei relevanten Workflow-/Berechtigungsänderungen, nach
   Installation oder Upgrade sowie manuell; nicht pauschal vor jedem Bug-Run.
2. Die Attestation ist ein GitHub-Actions-Cache-Eintrag, dessen Schlüssel einen
   SHA-256-Fingerprint aus Action-Version, kanonischer Berechtigungskonfiguration
   und versioniertem Testvertrag enthält.
3. Ein Cache-Miss startet automatisch genau einen Smoke. Erfolg setzt denselben
   Bug-Lauf fort; Fehler blockiert den produktiven Agenten, macht den Workflow
   rot und setzt `status:needs-human`.
4. Tatsächliche erfolgreiche Toolaufrufe werden maschinenlesbar erfasst. Der
   Nachweis verlangt je einen Bash-, Write- und Edit-Erfolg sowie den exakten
   erwarteten Endinhalt einer synthetischen Datei.
5. Der reusable Workflow liegt zentral im Harness; der Agent läuft über einen
   gepinnten Caller im Zielrepository. Immogent ist der erste reale Consumer.

## Architektur

### Fingerprint

Ein deterministisches Harness-Skript erzeugt aus folgenden kanonischen Inputs
einen SHA-256-Fingerprint:

- tatsächlich verwendeter `claude-code-action`-Ref,
- kanonisch serialisierte `settings.permissions.allow`,
- konstante Version des Capability-Testvertrags.

Freie Zusatzwerte, Issue-Inhalte, Branchname und Secrets sind ausdrücklich kein
Teil des Fingerprints. Die produktive Bug-Pipeline und der Smoke verwenden
dieselbe Implementierung; duplizierte Fingerprint-Logik ist unzulässig.

### Cache-Attestation

Der Workflow prüft einen exakten, nicht präfixbasierten Cache-Key. Der Cache
enthält ein kleines JSON-Manifest mit Schema-Version, Fingerprint,
Capability-Vertrag, erfolgreichem Workflow-Run und Zeitpunkt. Ein Cache-Treffer
ist nur gültig, wenn das Manifest vollständig gelesen und gegen den berechneten
Fingerprint validiert wurde. Cache-Ablauf oder -Löschung führt zu einem neuen
Smoke.

Da GitHub-Caches nachträglich nicht überschrieben werden, kann nur ein
erfolgreicher Smoke den endgültigen Attestation-Key schreiben. Arbeitsartefakte
und fehlgeschlagene Ergebnisse verwenden diesen Key nicht.

### Capability-Smoke

Der Agent erhält einen eng begrenzten Prompt und einen pro Lauf erzeugten
synthetischen Zufallsmarker. Er muss:

1. einen definierten Bash-Befehl ausführen,
2. über das Write-Tool eine Datei im ephemeren Workspace anlegen,
3. über das Edit-Tool einen definierten Marker ersetzen.

Hooks beziehungsweise strukturierte Action-Ausgabe erfassen die tatsächlich
erfolgreichen Toolaufrufe. Ein nachgelagerter deterministischer Schritt lehnt den
Lauf ab, wenn eine Fähigkeit fehlt, ein Toolaufruf abgelehnt/fehlgeschlagen ist
oder der Dateiinhalt nicht exakt stimmt. Textausgaben des Agenten sind keine
Evidence.

Der Workflow besitzt keine Schritte zum Committen, Pushen oder Erstellen eines
PRs. Die Testdatei verbleibt im ephemeren Runner-Workspace.

### Self-Healing und Concurrency

Ein Bug-Lauf prüft zunächst die Attestation. Bei Miss ruft er den Capability-
Workflow auf. Eine Fingerprint-gebundene Concurrency-Gruppe mit
`cancel-in-progress: false` serialisiert parallele Smokes. Nach erfolgreichem
Smoke wird die Attestation erneut validiert, bevor der produktive Agent startet.

Schlägt der Smoke fehl, wird `status:needs-human` gesetzt und ein Kommentar mit
der fehlgeschlagenen Fähigkeit und dem Workflow-Link erzeugt. Der produktive
Agent-Step bleibt übersprungen; der Gesamtworkflow endet fehlgeschlagen.

### Installation und Credentials

`harness init` kann einen verwalteten dünnen Capability-Caller installieren.
Dieser reagiert auf relevante Pfadänderungen, `workflow_dispatch` und einen
expliziten Aufruf durch die Bug-Pipeline. Reusable Workflow und Caller sind auf
einen unveränderlichen Harness-Tag oder vollständigen SHA gepinnt.

Unterstützt werden die vorhandenen Credential-Wege `ANTHROPIC_API_KEY` und
`CLAUDE_CODE_OAUTH_TOKEN`. Sind beide nicht verfügbar, endet eine vorgelagerte
Prüfung mit klarer Meldung, ohne `claude-code-action` aufzurufen. Secret-Werte
werden weder in Fingerprint, Cache-Manifest, Logs noch Run-State geschrieben.

## Technische Akzeptanzkriterien

- TAC-01: Eine gemeinsame, deterministische Fingerprint-Implementierung wird
  von Smoke und Bug-Pipeline verwendet und ist mit Testvektoren abgedeckt.
- TAC-02: Der Cache-Restore erlaubt ausschließlich einen exakten Key und
  validiert das Manifest; Restore-Key-Präfixe sind unzulässig.
- TAC-03: Nur der vollständig erfolgreiche deterministische Verifier schreibt
  die finale Attestation.
- TAC-04: Der Verifier verlangt erfolgreiche Bash-, Write- und Edit-Events und
  den exakten erwarteten Dateiinhalt.
- TAC-05: Ein formal grüner Agent-Step ohne vollständige Tool-Evidence führt zu
  einem roten Capability-Workflow.
- TAC-06: Cache-Hit überspringt den kostenpflichtigen Smoke und erlaubt den
  produktiven Agent-Step.
- TAC-07: Cache-Miss erzeugt genau einen fingerprintgebundenen Smoke und setzt
  den wartenden Bug-Lauf nach erfolgreicher Attestation fort.
- TAC-08: Smoke-Fehler überspringt den produktiven Agenten, setzt
  `status:needs-human`, kommentiert die konkrete Ursache und endet rot.
- TAC-09: Der installierte Caller unterstützt relevante Pfadänderungen,
  `workflow_dispatch` sowie Wiederverwendung durch die Bug-Pipeline.
- TAC-10: Der Smoke kann weder committen noch pushen noch PRs erzeugen; seine
  GitHub-Token-Berechtigungen sind entsprechend minimal.
- TAC-11: Fehlende Credentials werden vor Agent-Start erkannt und keine
  Secret-Werte werden persistiert oder ausgegeben.
- TAC-12: `harness init` erzeugt/aktualisiert den markierten Caller idempotent
  und meldet bei einer nicht verwalteten Zieldatei einen Konflikt.
- TAC-13: Contract-Tests decken Hit, Miss, parallelen Miss, Capability-Fehler,
  ungültiges Manifest, Konfigurationsänderung und fehlende Credentials ab.
- TAC-14: Ein synthetischer Immogent-Smoke belegt Bash, Write und Edit sowie
  einen anschließenden Cache-Hit ohne zweiten Agentenaufruf.
- TAC-15: Dokumentation beschreibt Kostenverhalten, Attestation-Lebensdauer,
  manuelle Ausführung, Fehlerdiagnose und sicheren Rollout.

## Verifikation

- `npm run check`,
- `actionlint` für reusable Workflow und Caller,
- deterministische Unit-/Contract-Tests für Fingerprint, Manifest und
  Workflow-Verträge,
- realer synthetischer Smoke in Immogent,
- zweiter Lauf mit nachgewiesenem Cache-Hit,
- negativer Test mit einer absichtlich fehlenden Capability ohne produktiven
  Agentenstart,
- Prüfung der Prozess-Audit-Ereignisse und des vollständigen Harness-Runs.

## Rollout

1. Harness-Implementierung und Contract-Tests mergen.
2. Unveränderlichen Harness-Release veröffentlichen.
3. Den verwalteten Caller und die aktualisierte Bug-Pipeline in Immogent über
   `harness init` installieren.
4. Reale positive und negative synthetische Smokes ausführen.
5. Erst nach erfolgreicher Evidence produktive Bug-Agentenläufe aktivieren.

## Rollback

Der Zielrepository-Caller und die Bug-Pipeline werden über einen geprüften
Folgechange auf den vorherigen gepinnten Harness-Ref zurückgesetzt. Bereits
erzeugte Cache-Attestations sind aufgrund des Fingerprints für abweichende
Konfigurationen nicht gültig. Es werden keine Datenbankmigrationen oder
persistenten Produktdaten verändert.

