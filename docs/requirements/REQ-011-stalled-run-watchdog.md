---
id: REQ-011
type: requirement
title: Deterministischer Stall-Watchdog für hängende Runs
status: approved
owner: product
risk: medium
created: 2026-08-13
updated: 2026-08-23
---

# REQ-011: Deterministischer Stall-Watchdog für hängende Runs

## Problem

Ein Run kann hängen bleiben, ohne dass ein Mensch es bemerkt: Ein
`workflow_dispatch` schlägt fehl, ein Event geht verloren, ein Agent wird nie
zugewiesen, oder eine erwartete automatische Aktion (z. B. `agent-assign`)
wurde schlicht nie ausgelöst. Der bestehende `harness reconcile`-Befehl heilt
verpasste Gate-, Merge- und Dokumentationsfortsetzungen, erkennt aber nicht,
ob eine erwartete automatische Aktion für einen bereiten, nicht blockierten
Run überhaupt jemals gestartet wurde. Ohne aktive Chat-Sitzung bleibt ein
solcher Run unbemerkt liegen, bis ein Mensch zufällig nachschaut.

Der Harness besitzt inzwischen einen vertrauenswürdigen, zeitgesteuerten
Reconcile-Lauf. Dessen deterministischer Sweep soll um die klar getrennte
Stall-Erkennung ergänzt werden; ein zweiter konkurrierender Scheduler ist
nicht erforderlich.

## Nutzer-Outcome

Ein periodisch laufender, rein deterministischer Prüfschritt (kein
KI-Aufruf) erkennt Runs, für die eine automatische Aktion überfällig ist,
und stößt für genau diese Runs eine bereits bestehende, begrenzte
Automation erneut an. Ein KI-Agent wird ausschließlich als Folge eines
positiven, deterministischen Befunds aktiv — niemals periodisch "auf
Verdacht". Jeder dadurch ausgelöste Agentenschritt protokolliert sein
Vorgehen im jeweiligen Zielrepository nach demselben Muster wie jede andere
Harness-Automation (REQ-005).

## Akzeptanzkriterien

- AC-01: Ein zeitgesteuerter GitHub-Actions-Workflow (`schedule`) ruft
  periodisch ausschließlich ein deterministisches Prüfskript auf. Das
  Skript enthält keinen KI-/LLM-Aufruf und benötigt keine offene
  Chat-Sitzung.
- AC-02: Das Prüfskript untersucht repo-weit alle offenen
  Tracking-Issues (`harness:run`) und bestimmt für jeden Run rein
  regelbasiert, ob eine automatische Folgeaktion überfällig ist.
- AC-03: Ein Run gilt nur dann als "hängend", wenn (a) seine Phase eine
  automatische Aktion vorsieht, (b) kein offenes menschliches Gate diese
  Aktion blockiert, (c) seit der letzten Zustandsänderung mindestens ein
  konfigurierbarer Schwellwert vergangen ist und (d) das bestehende
  Wiederholungslimit für diese Aktion noch nicht ausgeschöpft ist.
- AC-04: Runs mit einem offenen menschlichen Gate werden vom Watchdog
  niemals angestoßen; das bleibt ausschließlich Aufgabe des Menschen bzw.
  von `harness reconcile` für Label-Nachholung.
- AC-05: Für jeden als hängend erkannten Run löst das Skript ausschließlich
  eine bereits bestehende, klar benannte und begrenzte Automation aus
  (z. B. erneute Agentenzuweisung) — keine freie, unbegrenzte
  Agenteninteraktion und keine neue Art von Seiteneffekt.
- AC-06: Zwei sich überschneidende Prüfläufe oder zwei Anstöße für
  denselben Run innerhalb desselben Zeitfensters erzeugen keinen doppelten
  Anstoß.
- AC-07: Jeder Anstoß zählt gegen ein eigenes, begrenztes Wiederholungslimit.
  Nach Ausschöpfung wird der Run nicht erneut angestoßen, sondern für einen
  Menschen sichtbar eskaliert (`status:needs-human`).
- AC-08: Jeder tatsächlich ausgelöste Agentenschritt protokolliert Zeitpunkt,
  Prozesskennung, Akteur (`harness-watchdog`), Rolle, betroffenen Run,
  Begründung (welcher Schwellwert überschritten wurde) und Ergebnis über den
  bestehenden verlustsicheren Audit-Mechanismus (REQ-005).
- AC-09: Der Watchdog ist als benannte, installierbare Workflow-Vorlage
  (siehe REQ-006) in beliebige Zielrepositories einsetzbar, nicht als
  Handarbeit pro Repository.
- AC-10: Der Watchdog verändert niemals ein menschliches Gate-Ergebnis,
  mergt nichts und umgeht keine bestehende Freigabe- oder Risikoprüfung.
- AC-11: Dokumentation beschreibt Schwellwerte, Ausschlüsse und das
  Zusammenspiel mit `harness reconcile` vollständig und widerspruchsfrei.

## Nicht-Ziele

- eine KI-Entscheidung darüber, ob ein Run "hängt" — das bleibt vollständig
  regelbasiert,
- automatisches Auflösen oder Umgehen menschlicher Gates,
- Verkürzung, Umgehung oder Vervielfachung bestehender
  Wiederholungs-/Iterationslimits,
- ein neuer externer Scheduler-, Queue- oder Datenbankdienst (nur die
  vorhandene GitHub-Actions-`schedule`-Fähigkeit),
- erneutes Anstoßen bereits abgeschlossener (`complete`) oder bereits
  eskalierter Runs,
- Ersatz oder Duplizierung von `harness reconcile`; der Watchdog ergänzt den
  bestehenden Sweep nur um überfällige automatische Aktionen.

## Abhängigkeiten

- bestehende reine Zustandsmaschine (`src/state/state-machine.ts`) als
  einzige Quelle für "welche automatische Aktion ist als Nächstes fällig",
- bestehende Wiederholungs-/Eskalationslogik aus REQ-001,
- bestehender Agentenzuweisungs-Pfad (`harness agent-assign`, REQ-003),
- aktueller, verifizierbarer GitHub-Copilot-Assignment-Vertrag und sichere
  Reconciliation aus Issue #62,
- installierbarer Workflow-Vorlagen-Katalog aus REQ-006/SPEC-006,
- verlustsicherer Prozess-Audit-Mechanismus aus REQ-005.

## Kostenrahmen

Der Prüfschritt selbst verursacht keine Agentenkosten (kein KI-Aufruf). Nur
ein tatsächlich ausgelöster Anstoß kann Agentenkosten verursachen und bleibt
durch das bestehende 0-Euro-Kontingent- und Eskalationsverhalten begrenzt.
