---
id: REQ-005
type: requirement
title: Verlustsichere und vollständig korrelierbare Auditierung von Harness-Prozessschritten
status: approved
owner: product
risk: high
created: 2026-08-02
updated: 2026-08-06
---

# REQ-005: Verlustsichere und vollständig korrelierbare Auditierung von Harness-Prozessschritten

> Herkunft: ursprünglich als REQ-002 im Immogent-Repository angelegt, dort im
> Rahmen der Trennung nach [ADR-003](https://github.com/munichdeveloper/Immogent/blob/main/docs/40-architecture/decisions/ADR-003-separate-agent-harness-repository.md)
> entfernt und hierher übernommen (2026-08-06). Der Beobachtungsumfang wurde
> dabei bewusst auf tatsächliche Harness-Automation eingeschränkt; siehe
> [[../../../Immogent/docs/50-quality/process-audit/automation|automation.md]]
> im Immogent-Repo für die aktuell betriebene Implementierung.

## Problem und Kontext

Der Harness orchestriert Requirement-, Spec-, Implementierungs-, Verifikations-
und Gate-Schritte über Agenten-Läufe, Copilot-Runs und eigene GitHub-Actions-
Trigger in seinen angebundenen Referenzprojekten (aktuell Immogent). Beim
Bootstrap des ersten Audit-Writers in Immogent wurden zwei GitHub-Grenzen
nachgewiesen:

1. GitHub akzeptiert in `repository_dispatch.client_payload` höchstens zehn
   Top-Level-Felder. Der vollständige Audit-Vertrag mit vierzehn Feldern wurde
   deshalb mit HTTP 422 abgewiesen.
2. Eine GitHub-Actions-Concurrency-Gruppe hält nur einen laufenden und einen
   wartenden Lauf. Bei einem Burst aus sieben Ereignissen stornierte GitHub
   fünf angenommene Writer-Läufe trotz `cancel-in-progress: false`.

Der manuelle Bootstrap verlor keine Daten, weil die Ereignisse stabile
Idempotenzschlüssel besaßen, seriell erneut zugestellt und ihre Commits einzeln
bestätigt wurden. Unbeaufsichtigte Produzenten dürfen von diesem manuellen
Eingriff jedoch nicht abhängen.

**Explizit außerhalb des Scopes:** Fachlicher Immogent-Produktbetrieb (jede
PR, jedes Deployment, jeder externe Check unabhängig vom Akteur) ist kein
Harness-Prozessschritt und wird nicht auditiert. Beobachtet wird ausschließlich
Automation, die der Harness selbst auslöst (Agenten-Läufe, Copilot-Runs,
Harness-Gates und -Trigger).

## Ziel und Nutzen

- Jeder Harness-Produzent kann den vollständigen Audit-Vertrag über GitHub
  zustellen.
- Ein angenommener Auftrag gilt erst als zugestellt, wenn der zugehörige
  `idempotency_key` dauerhaft auf `main` des jeweiligen Referenzprojekts
  auffindbar ist.
- Ereignis-Bursts führen weder zu stillen Stornierungen noch zu Duplikaten.
- Zeitpunkt, Prozess-Kennung, Akteur, Zugriffsrolle, Begründung, Beschreibung
  und optionale Evidence bleiben vollständig erhalten.
- Das Journal bleibt allein durch Dateinamen chronologisch sortierbar.

## User Stories

Als Product Owner möchte ich nachweisen können, welcher menschliche oder
automatische Akteur einen wirksamen Harness-Prozessschritt über welche Rolle
ausgeführt hat, damit Freigaben und Automationen später prüfbar bleiben.

Als externer Produzent (z. B. der Harness selbst) möchte ich ein vollständiges
Ereignis mit einem stabilen Idempotenzschlüssel zustellen und dessen Persistenz
bestätigen können, damit Netzwerkfehler oder Wiederholungen weder Verlust noch
Duplikate verursachen.

Als Platform Operator möchte ich mehrere Ereignisse unmittelbar nacheinander
zustellen können, ohne sie manuell zu serialisieren oder stornierte Actions
nacharbeiten zu müssen.

## Akzeptanzkriterien

- [x] AC-1: Ein externer Produzent kann alle Pflicht- und optionalen Felder
  des Audit-Schemas in einem von GitHub akzeptierten `repository_dispatch`
  übertragen.
- [x] AC-2: Der Writer akzeptiert das versionierte Envelope und den zuvor
  produktiv verwendeten flachen Zehn-Felder-Payload während einer
  dokumentierten Übergangsphase.
- [x] AC-3: Ein synthetischer Burst aus mindestens sieben eindeutigen
  Ereignissen erzeugt für jeden Idempotenzschlüssel genau einen validen
  Audit-Eintrag; kein zugehöriger Writer-Lauf wird durch die eigene
  Concurrency-Konfiguration storniert.
- [x] AC-4: Parallele Push- oder Dateinamenskollisionen werden automatisch
  wiederholt. Bleibt eine Persistenz aus, endet der Lauf sichtbar
  fehlgeschlagen und derselbe Idempotenzschlüssel kann sicher erneut
  zugestellt werden.
- [x] AC-5: Eine erfolgreiche Annahme des Dispatches gilt nicht als
  Zustellbestätigung; der Idempotenzschlüssel muss auf `main` gefunden werden,
  bevor eine Outbox als zugestellt markiert wird.
- [x] AC-6: Wiederholte Zustellung desselben Idempotenzschlüssels erzeugt
  keinen zweiten fachlichen Audit-Eintrag.
- [x] AC-7: Jeder neue Eintrag enthält sichtbar Zeitpunkt, Prozess-Kennung,
  Akteur, verwendete Rolle, Ergebnis, Begründung und Beschreibung; optionale
  Artefakte, Korrelationen und Evidence bleiben verlustfrei erhalten.
- [x] AC-8: Dateinamen sortieren lexikografisch weiterhin chronologisch und
  bleiben auch bei gleichzeitigen Ereignissen eindeutig.
- [x] AC-9: Payloads mit unbekannter Version, unbekannten Enums,
  Secretmustern oder ungültigen Zeitstempeln werden ohne Commit abgelehnt.
- [x] AC-10: Die Lösung verwendet nur bestehende GitHub-Actions- und
  Repository-Ressourcen im 0-Euro-Kostenrahmen und führt keine neue
  Dienstidentität oder Secretklasse ein.
- [x] AC-11 (2026-08-06 nachgezogen): Der Beobachter reagiert ausschließlich
  auf Ereignisse, die vom Harness selbst ausgelöst werden. Generischer
  Produktbetrieb eines Referenzprojekts (beliebige PR, beliebiges Deployment,
  beliebiger externer Check) löst kein Audit-Ereignis aus.

## Nicht-Ziele

- keine neue externe Queue oder kostenpflichtige Event-Plattform
- keine Änderung fachlicher Produktdaten eines Referenzprojekts
- keine Transactional-Outbox für Laufzeitaktionen eines Referenzprojekts
- kein nachträgliches Umschreiben bestehender Audit-Dateien
- keine exakt-einmal-Semantik über verteilte Systeme hinweg
- keine Beobachtung von Produktbetrieb, der nicht vom Harness ausgelöst wurde

## Fachregeln und Grenzfälle

- Zustellung ist `effect-confirmed` und mindestens einmal; Idempotenz bildet
  daraus genau einen fachlichen Journaleintrag.
- Bestehende Ereignisse und deren IDs bleiben unverändert gültig.
- Ein Writer darf nur eine neu erzeugte Datei unter dem Audit-Event-Pfad
  committen.
- Gleichzeitige Ereignisse mit identischem Zeitpunkt müssen unterschiedliche,
  deterministisch wiederholbare Dateipfade erhalten.
- Ein fehlgeschlagener Writer-Lauf ist ein sichtbarer Betriebsfehler und darf
  nicht als erfolgreiche Zustellung quittiert werden.

## Datenschutz, Sicherheit und rechtliche Auswirkungen

Audit-Ereignisse enthalten technische Metadaten, aber keine Tokens, Cookies,
Passwörter, Secretwerte oder personenbezogenen Produktdaten. Der Writer behält
minimale `contents: write`-Rechte im jeweiligen Referenzprojekt. Änderungen am
Writer sind wegen des direkten Append-Pfads auf `main` als hohes Risiko
eingestuft und benötigen Review, grüne Tests und ein SHA-gebundenes
Human-Gate.

## Abhängigkeiten

- bestehendes Process-Audit-Schema und dessen kontrollierte Enums (aktuell
  implementiert im Immogent-Repo)
- GitHub `repository_dispatch`, Actions und `GITHUB_TOKEN` des jeweiligen
  Referenzprojekts
- bestehende Recorder- und Validator-Skripte

## Betriebshinweis

Der Beobachter (`workflow_run`/`pull_request_target`/`repository_dispatch`)
muss aus technischen Gründen im jeweiligen Referenzprojekt selbst laufen, da
GitHub diese Events nur repo-lokal ausliefert. Dieses Requirement beschreibt
daher eine Harness-Fähigkeit, deren Beobachtungskomponente dezentral in jedem
angebundenen Repository betrieben wird; Spezifikation, Schema und
Governance-Entscheidungen liegen zentral im Harness-Namensraum.

## Offene Fragen

Der Beobachter-Trigger muss aus technischen Gründen (siehe
Betriebshinweis) repo-lokal bleiben. Die Payload-Konstruktionslogik
dahinter könnte künftig, analog zu REQ-006/SPEC-006, als reusable
Workflow zentralisiert und über den dortigen Installationsmechanismus
verteilt werden, sodass nur noch der zwingend repo-lokale Trigger-Teil
projektspezifisch bleibt. Dies ist keine Voraussetzung für dieses
Requirement und wird hier nur als mögliche spätere Vereinheitlichung
vermerkt.
