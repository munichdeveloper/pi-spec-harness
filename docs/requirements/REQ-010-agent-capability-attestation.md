---
id: REQ-010
type: requirement
title: Verlässlicher Capability-Nachweis für Cloud-Agenten
status: review
owner: product
risk: high
created: 2026-08-13
updated: 2026-08-13
source_issue: 28
---

# REQ-010: Verlässlicher Capability-Nachweis für Cloud-Agenten

## Problem

Ein nicht-interaktiver Cloud-Agent kann einen formal erfolgreichen Workflow
beenden, obwohl notwendige Tool-Aufrufe durch seine Berechtigungskonfiguration
abgelehnt wurden. Ein grüner GitHub-Actions-Lauf beweist daher nicht, dass der
Agent Bash-Befehle ausführen sowie Dateien schreiben und editieren konnte.

Dieses Fehlverhalten wurde in der Bug-Pipeline beobachtet: Ein Agent verlor den
Großteil seiner Tool-Aufrufe an nicht erfüllbare Approval-Anforderungen, während
der umgebende Workflow trotzdem keinen eindeutigen Capability-Fehler meldete.
Selbst wenn `Bash(*)`, `Write` und `Edit` in einer konkreten Pipeline
konfiguriert sind, ersetzt diese deklarative Konfiguration keinen semantischen
Nachweis ihrer tatsächlichen Wirksamkeit.

## Nutzer-Outcome

Vor einem produktiven Cloud-Agentenlauf liegt für exakt dessen Action-Version,
Berechtigungskonfiguration und Capability-Testvertrag ein erfolgreicher,
maschinenprüfbarer Nachweis vor. Fehlt der Nachweis, erzeugt der Harness ihn
automatisch mit einem synthetischen Smoke-Test. Ein produktiver Agent startet
nur, wenn Bash, Write und Edit tatsächlich erfolgreich ausgeführt wurden.

## Akzeptanzkriterien

- AC-01: Der Capability-Smoke führt nachweislich je einen erfolgreichen
  `Bash`-, `Write`- und `Edit`-Toolaufruf aus.
- AC-02: Ein deterministischer Prüfschritt validiert sowohl die protokollierten
  Toolaufrufe als auch den exakten Inhalt einer synthetischen Testdatei.
- AC-03: Aussagen des Agenten über den Erfolg gelten nicht als Nachweis.
- AC-04: Ein erfolgreicher Nachweis ist an einen SHA-256-Fingerprint aus
  Action-Version, Berechtigungseinstellungen und Testvertrag gebunden.
- AC-05: Ein produktiver Bug-Agentenlauf startet nur bei einem exakten,
  gültigen Attestation-Treffer.
- AC-06: Fehlt die Attestation, startet automatisch genau ein Capability-Smoke
  für den Fingerprint und setzt den ursprünglichen Lauf nach Erfolg fort.
- AC-07: Bei fehlgeschlagener Capability-Prüfung startet kein produktiver
  Agent. Der Workflow wird rot und das Issue erhält `status:needs-human` mit
  der konkret fehlgeschlagenen Fähigkeit.
- AC-08: Parallel eintreffende Läufe erzeugen nicht mehrere Capability-Smokes
  für denselben Fingerprint.
- AC-09: Der Smoke läuft bei relevanten Workflow-/Berechtigungsänderungen, nach
  Installation oder Upgrade im Zielrepository und manuell per
  `workflow_dispatch`; er läuft nicht pauschal vor jedem Bug-Run.
- AC-10: Der Smoke verwendet ausschließlich synthetische Marker in einem
  ephemeren Runner-Workspace und erzeugt weder Commit, Push noch Pull Request.
- AC-11: Der Capability-Workflow wird zentral versioniert und über einen dünnen,
  gepinnten Caller im Zielrepository ausgeführt.
- AC-12: Fehlende Agent-Credentials werden vor Agent-Start eindeutig gemeldet.
- AC-13: Contract-Tests im Harness und ein realer synthetischer Consumer-Smoke
  in Immogent belegen das Verhalten end-to-end.

## Ausführungsmodell

Der Nachweis wird nicht vor jedem produktiven Lauf neu erzeugt. Ein erfolgreicher
GitHub-Actions-Cache-Eintrag dient als Attestation für exakt einen Fingerprint.
Bei Änderung oder Verlust des Cache-Eintrags heilt sich der Ablauf durch einen
neuen Smoke selbst. Der eigentliche Smoke kann Claude-Credits verbrauchen;
Cache-Prüfung und deterministische Verifikation verursachen keine zusätzlichen
Agentenkosten.

## Nicht-Ziele

- allgemeine Sandbox- oder Sicherheitszertifizierung des Cloud-Agenten,
- Prüfung beliebiger weiterer Agent-Tools in diesem Slice,
- persistente Datenbank für Attestations,
- Committen synthetischer Smoke-Artefakte,
- Umgehung oder Aufweichung bestehender Merge- und Human-Gates,
- Unterstützung zusätzlicher Agent-Anbieter in der ersten Version.
