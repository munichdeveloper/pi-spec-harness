---
id: REQ-001
type: requirement
title: Sichere unbeaufsichtigte Harness-Runs
status: approved
owner: product
risk: high
created: 2026-07-28
updated: 2026-07-28
---

# REQ-001: Sichere unbeaufsichtigte Harness-Runs

## Problem

Der Harness soll einen spezifikationsgetriebenen Entwicklungsdurchlauf ohne
laufende Chat-Sitzung fortsetzen können. Die aktuelle Automation kann jedoch
fehlgeschlagene Agenten-Commits direkt nach `main` übernehmen, technische
Gates vor Abschluss der Checks als bestanden markieren und bei parallelen Runs
die falsche Spec, den falschen PR oder das falsche Tracking-Issue auswählen.

## Nutzer-Outcome

Ein Product Owner kann einen Run über das persistente Tracking-Issue steuern.
Der Harness setzt ausschließlich den eindeutig gebundenen Run fort, bewahrt
fehlgeschlagene Agentenarbeit außerhalb von `main`, zählt Korrekturiterationen
und wartet vor jedem risikoreichen Merge auf das vorgesehene Human Gate.

## Akzeptanzkriterien

- AC-01: Ein Run besitzt genau ein Tracking-Issue mit `harness:run`; ein
  Implementierungs-Issue verwendet ein separates Label.
- AC-02: Spec, Implementierungs-Issue und PR werden über die Run-ID und den
  kanonischen Run-State eindeutig gebunden.
- AC-03: Kein fehlgeschlagener oder ungeprüfter Agenten-Commit wird direkt
  nach `main` geschrieben.
- AC-04: Ein Verification-Gate wird erst nach abgeschlossenen grünen Checks,
  einem nicht-draft PR und ohne offene umsetzbare Review-Threads bestanden.
- AC-05: Jeder automatische Korrekturversuch wird im Run-State gezählt; nach
  drei fehlgeschlagenen Versuchen öffnet der Harness eine Eskalation.
- AC-06: Offene oder fehlgeschlagene technische Gates blockieren den
  Phasenfortschritt.
- AC-07: Spec- und Merge-Automation reagiert nur auf das konkret aufgelöste
  Gate und den im Run-State gebundenen Gegenstand.
- AC-08: Parallele Runs können einander weder Spec, Issue, PR noch Gate
  zuordnen.
- AC-09: State-Machine, CLI und Workflow-Verträge besitzen automatisierte
  Regressionstests.
- AC-10: Dokumentation und Quick Reference beschreiben den realen, sicheren
  Ablauf vollständig und widerspruchsfrei.

## Nicht-Ziele

- autonome Produktentscheidungen,
- Production-Migrationen oder echte Nutzerdaten,
- ein neuer externer State- oder Queue-Dienst,
- mehr als drei automatische Produktkorrekturversuche,
- Auto-Merge ohne die risikobasierte Gate-Policy.
