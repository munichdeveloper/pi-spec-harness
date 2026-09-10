---
id: SPEC-017
title: Fail-closed post-install sanity and zero-knowledge intake
status: approved
requirements:
  - REQ-017
implementation_issue: 187
implementation_assignee: harness-agent
---

# SPEC-017: Post-install sanity and zero-knowledge intake

## Ziel

Jede Installation erzeugt einen verwalteten Sanity-Check und startet ihn nach
Wirksamwerden auf dem Default Branch. Der Zustand ist erst `ready`, wenn der
konfigurierte Agenten-, Workflow- und Repositoryvertrag nachweislich
ausfuehrbar ist; andernfalls lautet er `installed-but-not-ready`.

## Technischer Vertrag

- Der ausgewaehlte Coding-Agent und genau dessen Authentisierungsmechanismus
  werden geprueft. Fehlende API-Keys, OAuth-Tokens oder App-Identitaeten sind
  ein klarer Fehler im Vollmodus.
- Secret-Werte werden niemals ausgegeben, persistiert oder als Workflow-Input
  weitergereicht.
- Caller- und Reusable-Permissions, immutable Workflow-Pins, Workflow-Status,
  Actions-Einstellungen und benoetigte Labels werden deterministisch geprueft.
- Der bestehende Capability-Smoke wird erweitert; es entsteht kein paralleler
  Readiness-Mechanismus.
- Ein expliziter eingeschraenkter Modus benennt deaktivierte Faehigkeiten. Das
  Fehlen von Credentials ist kein implizites Opt-out.
- `issues.opened` startet einen read-only Intake. Klassifikation und technische
  Labels sind interne Details. Fehlende fachliche Informationen werden in
  Alltagssprache erfragt.
- Eine inhaltliche Freigabe buendelt atomar Run-Initialisierung und die naechste
  zulaessige Delegation. Bereits auditierte Approval-Evidence wird nicht erneut
  verlangt.
- Der Run-Dokumentations-Finalizer verarbeitet Label-Events nur fuer echte
  `harness:run`-Issues.
- Der Bug-Triage-Caller gewaehrt explizit die vom Reusable benoetigten Rechte,
  damit Berechtigungsfehler nicht erst als `startup_failure` sichtbar werden.

## Akzeptanzkriterien

1. Eine Vollinstallation ohne Agent-Credentials erzeugt automatisch einen
   roten, handlungsorientierten Sanity-Check.
2. Inkompatible Caller-/Reusable-Permissions werden vor einem echten Issue
   erkannt.
3. Eine synthetisch vollstaendig konfigurierte Installation wird gruen
   attestiert.
4. Provider-, Credential-Vertrags-, Pin- oder Permission-Aenderungen
   invalidieren die Attestation.
5. Logs, Artifacts und Audit enthalten keine Secret-Werte.
6. Ein natuerlich formuliertes Issue erreicht ohne Labelwissen einen
   verstaendlichen naechsten Zustand.
7. Der Happy Path verlangt hoechstens eine inhaltliche Freigabe.
8. Normale Issue-Labels starten keinen Run-Dokumentations-Finalizer.
9. Die in dsb-new beobachtete Blockerkette ist durch Regressionstests gedeckt.

