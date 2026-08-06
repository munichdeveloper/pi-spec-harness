---
id: SPEC-005
type: software-spec
title: Verlustsichere Audit-Zustellung für Harness-Prozessschritte über GitHub Actions
status: approved
owner: engineering
risk: high
requirements:
  - REQ-005
implementation_assignee: "@github-copilot"
created: 2026-08-02
updated: 2026-08-06
---

# SPEC-005: Verlustsichere Audit-Zustellung für Harness-Prozessschritte über GitHub Actions

> Herkunft: ursprünglich als SPEC-016 im Immogent-Repository angelegt, dort im
> Rahmen der Trennung nach [ADR-003](https://github.com/munichdeveloper/Immogent/blob/main/docs/40-architecture/decisions/ADR-003-separate-agent-harness-repository.md)
> entfernt und hierher übernommen (2026-08-06).

## Zusammenfassung

Der Process-Audit-Writer eines Referenzprojekts (aktuell Immogent) wird gegen
zwei beobachtete GitHub-Grenzen gehärtet: maximal zehn Top-Level-Felder in
`client_payload` und das Stornieren mehrerer wartender Läufe innerhalb einer
Concurrency-Gruppe. Ein versioniertes, verschachteltes Envelope transportiert
den vollständigen Vertrag. Kollisionssichere Dateipfade, parallele Writer mit
optimistischem Push-Retry und bestätigungsbasierte Produzentenregeln verhindern
stillen Verlust und Duplikate.

Quelle ist [[../requirements/REQ-005-loss-safe-process-auditing|REQ-005]]. Der
reproduzierte Betriebsbefund und die ersten Evidence-Links stehen in
[Immogent Issue #67](https://github.com/munichdeveloper/Immogent/issues/67).

**Ergänzend (2026-08-06):** Der Beobachtungsumfang wurde in Immogent auf reine
Harness-Automation eingeschränkt (`deployment_status`, `check_run` und die
generischen CI-Workflows `Repository Quality`/`Preview E2E` wurden aus den
Triggern entfernt); siehe
[automation.md](https://github.com/munichdeveloper/Immogent/blob/main/docs/50-quality/process-audit/automation.md)
im Immogent-Repo für den aktuellen Stand der Implementierung.

## Verknüpfte Akzeptanzkriterien

- AC-1 bis AC-2: versioniertes Envelope und Legacy-Kompatibilität
- AC-3 bis AC-4: Burst-Verarbeitung, Konfliktretry und sichtbare Fehler
- AC-5 bis AC-6: bestätigte Zustellung und Idempotenz
- AC-7 bis AC-9: vollständiges Schema, chronologische Eindeutigkeit
  und Eingabevalidierung
- AC-10: bestehender 0-Euro-Kosten- und Berechtigungsrahmen
- AC-11: Beobachtung ausschließlich harness-ausgelöster Ereignisse

## Freizugebende technische Entscheidungen

1. **Envelope v1:** Neue Produzenten senden genau ein Top-Level-Feld
   `client_payload.audit`. Darin liegen `schema_version: 1` und sämtliche
   Audit-Felder. Damit bleibt der GitHub-Payload unter der Zehn-Felder-Grenze.
2. **Übergangskompatibilität:** Der Writer akzeptiert zusätzlich den bereits
   verwendeten flachen Payload mit höchstens zehn Feldern. Das Envelope ist
   kanonisch; der Legacy-Pfad wird dokumentiert und mit Vertragstests geschützt.
3. **Burst-Strategie:** Die stornierende globale Workflow-Concurrency wird
   entfernt. Writer dürfen parallel laufen, verwenden kollisionssichere,
   idempotenzbasierte Dateipfade und führen einen begrenzten
   Fetch/Rebase/Push-Retry aus. Ein endgültiger Konflikt schlägt sichtbar fehl.
4. **Zustellbestätigung:** Externe Produzenten behandeln HTTP 204 nur als
   Annahme. Erfolgreich zugestellt ist ein Ereignis erst, wenn sein
   `idempotency_key` im Journal auf `main` gefunden wurde; bis dahin bleibt es
   in der Produzenten-Outbox und wird mit Backoff erneut gesendet.
5. **Beobachtungsgrenze (ergänzt 2026-08-06):** Der Observer im
   Referenzprojekt hört ausschließlich auf `workflow_run` explizit benannter
   Harness-Workflows, auf `pull_request_target` mit `actor == 'Copilot'` und
   auf `repository_dispatch` vom Typ `process_audit`. `deployment_status` und
   `check_run` werden nicht beobachtet, da sie unabhängig vom auslösenden
   Akteur für jedes Deployment beziehungsweise jeden Check feuern.

Diese Entscheidungen erweitern weder Berechtigungen noch Kosten und führen
keine neue Infrastruktur ein.

## Scope und Nicht-Ziele

### Im Scope

- `audit`-Envelope v1 für `repository_dispatch`
- Normalisierung von Envelope-v1 und Legacy-Payload in denselben internen
  Recorder-Vertrag
- strikte Versions-, Schema-, Enum-, Zeitstempel- und Secretvalidierung
- eindeutiger Dateiname aus `occurred_at`, Audit-ID und einem stabilen,
  gekürzten Hash des Idempotenzschlüssels für automatische Ereignisse
- Rückwärtskompatibilität für bestehende sequenzbasierte Event-IDs und Dateien
- Entfernung der stornierenden Workflow-Concurrency
- konfliktfähiger Commit-/Push-Retry ohne Pfade außerhalb des Event-Journals
- Hilfsskript oder CLI-Lesepfad zum Bestätigen eines Idempotenzschlüssels auf
  dem Default-Branch
- Beobachtung ausschließlich harness-ausgelöster GitHub-Events (siehe
  technische Entscheidung 5)
- Unit-, Workflow-Vertrags- und synthetischer GitHub-Burst-Test
- Aktualisierung von Schema, Automation, Producer-Beispiel und RUN-Dokument

### Nicht im Scope

- Transactional-Outbox in Postgres für fachliche Laufzeitaktionen eines
  Referenzprojekts
- externe Message Queue, Vercel Queue oder kostenpflichtige Ressource
- neue GitHub-App, PAT- oder Secretklasse
- Mutation oder Umbenennung bestehender Audit-Ereignisse
- fachliche Produktänderungen an einem Referenzprojekt
- Beobachtung von Produktbetrieb, der nicht vom Harness ausgelöst wurde

## Externer Vertrag

Kanonischer Dispatch:

```json
{
  "event_type": "process_audit",
  "client_payload": {
    "audit": {
      "schema_version": 1,
      "occurred_at": "2026-08-02T15:21:32.000Z",
      "process_instance": "PI-IMMOGENT-RUN-008",
      "idempotency_key": "github-pr:68:merge:<sha>",
      "process_code": "PR_MERGE",
      "actor": "GITHUB_ACTIONS",
      "access_role": "GITHUB_ACTIONS_TOKEN",
      "supporting_access_roles": [],
      "outcome": "SUCCEEDED",
      "repository": "munichdeveloper/Immogent",
      "artifact": "PR-68",
      "correlation_ids": ["PI-IMMOGENT-RUN-008", "PR-68"],
      "evidence": ["https://github.com/munichdeveloper/Immogent/pull/68"],
      "reason": "Der freigegebene PR wurde gemerged.",
      "description": "Der Harness bestätigte und persistierte den Merge."
    }
  }
}
```

Das Workflow-Mapping übergibt den Payload als JSON an ein Node-Skript. Es
schreibt keine ungeprüften Payloadwerte über Shell-Interpolation in
`GITHUB_ENV`. Das Skript akzeptiert ausschließlich ein Objekt, genau eine
unterstützte Version und die dokumentierten Felder.

## Komponenten und Änderungen (Stand der Implementierung im Referenzprojekt)

- `.github/workflows/process-audit-automation.yml`
  - verschachtelten und Legacy-Payload sicher an den Normalizer übergeben
  - globale Concurrency entfernt
  - Commit-Retry weiterhin auf exakt eine Eventdatei begrenzt
  - Trigger auf harness-ausgelöste `workflow_run`-Namen, `pull_request_target`
    (Copilot) und `repository_dispatch` beschränkt
- `scripts/record_process_audit.mjs`
  - Envelope-normalisierte Eingabe verarbeiten
  - kollisionssichere ID-/Pfadbildung bei vorhandenem Idempotenzschlüssel
- Normalizer-/Confirmation-Modul
  - keine Shell-Auswertung unkontrollierter Werte
  - Bestätigung anhand des exakten Idempotenzschlüssels
- `scripts/validate_process_audit.mjs`
  - Legacy- und neue ID-/Dateinamensformate validieren
- Workflow- und Recorder-Tests
  - Envelope, Legacy, Invalid-Version, Secretmuster, Duplikat und Konflikt

Diese Komponenten laufen technisch weiterhin im jeweiligen Referenzprojekt
(aktuell Immogent unter `docs/50-quality/process-audit/`), da GitHub
`workflow_run`, `pull_request_target` und `repository_dispatch` nur repo-lokal
ausliefert. Die Spezifikation und Governance dieser Fähigkeit liegen zentral
im Harness-Namensraum.

## Sicherheit und Berechtigungen

- Workflow-Rechte bleiben auf `contents: write` begrenzt.
- Der Writer checkt ausschließlich den vertrauenswürdigen Default-Branch aus.
- Aus Payloads werden keine Shellbefehle, Dateipfade oder Git-Argumente direkt
  zusammengesetzt.
- Der Eventpfad wird ausschließlich aus validiertem UTC-Zeitpunkt,
  kontrollierten Enums und einem hexadezimalen Hash gebildet.
- Secrets und personenbezogene Produktdaten bleiben verboten.

## Fehlerfälle und Grenzfälle

- fehlendes oder unbekanntes `schema_version`: kein Commit, sichtbarer Fehler
- sowohl Envelope als auch Legacy-Felder gesetzt: Envelope wird nicht
  stillschweigend gemischt; widersprüchlicher Payload wird abgelehnt
- doppelter Idempotenzschlüssel: bestehender Pfad wird bestätigt, kein Commit
- zwei Ereignisse im selben Millisekundenzeitpunkt: unterschiedliche Hashes
- Push-Konflikt nach ausgeschöpften Retries: Workflow schlägt fehl; Produzent
  behält den Outbox-Eintrag und wiederholt denselben Schlüssel

## Migration und Rollback

Der Rollout war additiv: Envelope v1 und Legacy-Lesepfad wurden gemeinsam
aktiviert. Bestehende Eventdateien bleiben unangetastet. Die nachträgliche
Beobachtungseinschränkung (technische Entscheidung 5) ist ebenfalls additiv:
sie entfernt nur Trigger, ändert aber weder Schema noch bestehende Ereignisse.

## Freigabe

Die vier ursprünglichen technischen Entscheidungen wurden am 2026-08-02 unter
SPEC-016 im Immogent-Repo freigegeben (Tracking-Issue
[Immogent #69](https://github.com/munichdeveloper/Immogent/issues/69)). Die
fünfte, die Beobachtungsgrenze, wurde am 2026-08-06 direkt als Bugfix ohne
separates Ticket umgesetzt, nachdem sich herausstellte, dass der Observer
ungewollt auch nicht-harness-ausgelöste Immogent-Ereignisse erfasste.
