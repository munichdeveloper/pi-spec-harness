---
id: REQ-013
type: requirement
title: Vertrauenswürdige vollautomatische Review-Remediation
status: approved
owner: product
risk: high
created: 2026-08-23
updated: 2026-08-23
---

# REQ-013: Vertrauenswürdige vollautomatische Review-Remediation

## Problem

Auf PR #71 wurden Copilot-Findings nicht automatisch bearbeitet. Die
Review-Workflows endeten zunächst ohne Job als `action_required`; spätere
Ausführungen meldeten erfolgreich `unmanaged-pull-request`, weil kein offener
kanonischer Run an den PR gebunden war. Dadurch blieb eine erforderliche
Prozessaktion unsichtbar liegen und musste per Chat übernommen werden.

## Nutzer-Outcome

Ein durch den Harness erzeugter Implementierungs-PR wird vom ersten Review bis
zur Merge-Fortsetzung ohne Chat-Babysitting verarbeitet. Findings starten genau
eine Agenten-Remediation auf dem bestehenden Branch. Checks und Agentenfortschritt
werden deterministisch überwacht, erledigte Threads beantwortet und aufgelöst.
Nur fachliche, sicherheitsrelevante oder kostenwirksame Entscheidungen erzeugen
ein Human-Gate.

## Akzeptanzkriterien

- AC-01: Jeder Harness-Implementierungs-PR ist vor seinem ersten Review an genau
  einen offenen `harness:run` gebunden und trägt `<!-- harness:<run-id> -->`.
- AC-02: Ein nicht gebundener PR darf nicht still erfolgreich als
  `unmanaged-pull-request` enden. Er wird entweder eindeutig gebunden oder mit
  maschinenlesbarem Blockierungszustand, Recovery-Aktion und Audit sichtbar.
- AC-03: Review-Ereignisse werden durch auf dem Default-Branch vertrauenswürdigen
  Code verarbeitet, ohne PR-eigene Workflow-Änderungen freigeben zu müssen.
- AC-04: Dabei wird PR-Head-Code niemals mit einem schreibfähigen Token
  ausgecheckt oder ausgeführt.
- AC-05: Actionable Copilot-Threads erzeugen genau ein Remediation-Paket für den
  konfigurierten Coding Agent auf dem bestehenden PR-Branch.
- AC-06: Der Prozess pollt Agentenfortschritt und Checks begrenzt, setzt sich nach
  Events oder Watchdog-Reconciliation fort und benötigt keine offene Chat-Sitzung.
- AC-07: Implementierte Findings werden mit Commit- und Testevidenz beantwortet
  und erst danach aufgelöst.
- AC-08: Duplikate, Restarts und Concurrency erzeugen weder doppelte Agentenaufträge
  noch verlorene Findings.
- AC-09: Jeder Dispatch, Skip, Block, Retry und Abschluss wird verlustsicher über
  den bestehenden Prozess-Audit-Vertrag protokolliert.
- AC-10: Ein synthetischer E2E-Lauf belegt Review → Agent Fix → CI →
  Thread-Auflösung → Merge-Fortsetzung.

## Nicht-Ziele

- Ausführung untrusted PR-Codes mit Write-Credentials,
- Umgehung echter Human-Gates oder Branch-Protection,
- automatische inhaltliche Freigabe von Produkt-, Sicherheits- oder
  Kostenentscheidungen,
- Unterstützung beliebiger Fremd-PRs ohne Harness-Kontext in dieser Version.

## Kostenrahmen

Die Lösung verwendet GitHub Actions, GitHub Copilot und bestehende
Repository-Ressourcen im vorhandenen 0-Euro-Kostenrahmen. Bei erschöpftem
Kontingent wird sichtbar blockiert, nicht kostenpflichtig ausgewichen.
