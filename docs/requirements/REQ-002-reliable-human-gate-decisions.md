---
id: REQ-002
type: requirement
title: Zuverlässige und bewertbare Human-Gate-Entscheidungen
status: review
owner: product
risk: high
created: 2026-07-30
updated: 2026-07-30
---

# REQ-002: Zuverlässige und bewertbare Human-Gate-Entscheidungen

## Problem

Human-Gates werden aktuell über generische Labels auf einem persistenten
Tracking-Issue entschieden. Die Verarbeitung hängt jedoch von einem einmaligen
GitHub-Label-Event ab. Ist der Trigger-Workflow zu diesem Zeitpunkt noch nicht
auf dem Default-Branch, vorübergehend deaktiviert oder fehlgeschlagen, bleibt
eine bereits getroffene Entscheidung unbemerkt liegen. GitHub spielt das Event
später nicht erneut aus.

Zudem zeigt das Tracking-Issue für ein offenes Gate nur eine kurze Frage. Ohne
Änderungsumfang, Akzeptanzkriterien, Risiken, Evidence und explizite Nicht-Ziele
kann ein Product Owner die verlangte Freigabe nicht fundiert bewerten.

## Nutzer-Outcome

Ein Product Owner kann im Tracking-Issue eindeutig erkennen, was genau
freigegeben oder abgelehnt wird. Eine gültige Entscheidung wird genau einmal
dem aktuell offenen Gate zugeordnet und auch nach einem verpassten Event
automatisch oder explizit nachgeholt. Bereits konsumierte oder alte Labels
können kein späteres Gate unbeabsichtigt auflösen.

## Akzeptanzkriterien

- AC-01: Ein Human-Gate zeigt dauerhaft Frage, fachlich-technischen Umfang,
  Akzeptanzkriterien, Evidence, Risiken, Auswirkungen, Nicht-Ziele und die nach
  Freigabe ausgeführte Aktion.
- AC-02: Ein PR-bezogenes Gate zeigt PR-Nummer und vollständige gebundene
  Head-SHA; eine Entscheidung gilt ausschließlich für diesen Checkpoint.
- AC-03: Beim Öffnen eines Gates entfernt der Harness alte Approved- und
  Rejected-Labels, bevor das neue Gate entscheidbar wird.
- AC-04: Nur ein GitHub-Label-Event, das nach Öffnung des konkreten Gates
  erzeugt wurde, darf dieses Gate entscheiden. Actor und Zeitpunkt werden als
  Decision-Evidence gespeichert.
- AC-05: Gleichzeitig gültige Approved- und Rejected-Entscheidungen werden
  nicht geraten, sondern als Konflikt zur menschlichen Klärung blockiert.
- AC-06: Der entschiedene Run-State wird persistent gespeichert, bevor
  Kommentare oder transiente Labels bereinigt werden.
- AC-07: Doppelte Events, wiederholtes `resume` und wiederholte Bereinigung
  sind idempotent.
- AC-08: Ein Reconciliation-Lauf verarbeitet gültige Entscheidungen, deren
  ursprüngliches Label-Event keinen aktiven Workflow erreicht hat.
- AC-09: Die erstmalige Installation oder Aktualisierung des Trigger-Workflows
  auf dem Default-Branch stößt Reconciliation für offene Gates an.
- AC-10: Reconciliation ist manuell per `workflow_dispatch` ausführbar und
  benötigt standardmäßig kein periodisches Polling.
- AC-11: Gleichzeitige Gate-Events desselben Repositories werden serialisiert,
  sodass sie den kanonischen Issue-State nicht gegenseitig überschreiben.
- AC-12: Unit-, Adapter- und Workflow-Vertragstests decken verpasste Events,
  alte Labels, widersprüchliche Entscheidungen, Speicher- und Cleanup-Fehler
  sowie die verständliche Gate-Darstellung ab.

## Nicht-Ziele

- zeitgesteuertes Polling im Minutentakt,
- ein externer Queue-, State- oder Workflow-Dienst,
- autonome Produkt- oder Merge-Entscheidungen,
- Freigaben allein durch Chat-Nachrichten oder unstrukturierte Kommentare,
- Änderungen an fachlichen Funktionen von Immogent.

