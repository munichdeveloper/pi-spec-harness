---
id: REQ-008
type: requirement
title: Verwalteter Harness-Kontextblock in der AGENTS.md des Zielrepositories
status: approved
owner: product
risk: low
created: 2026-08-07
updated: 2026-08-07
---

# REQ-008: Verwalteter Harness-Kontextblock in der AGENTS.md des Zielrepositories

## Problem

Ein Agent, der ohne vorheriges Gesprächsgedächtnis in einem angebundenen
Repository landet, hat aktuell kein zuverlässiges, sofort auffindbares
Signal dafür, dass der Prozess von `pi-spec-harness` orchestriert wird:
dass kanonischer Zustand in einem Tracking-Issue liegt (REQ-006/007,
`docs/human-gates.md`), was das dortige Label-Vokabular bedeutet, und dass
vor eigenständiger Arbeit an einem Issue zuerst geprüft werden sollte, ob
bereits ein Tracking-Issue mit Fortschritt existiert.

Zielrepositories besitzen häufig bereits eine eigene, produktspezifische
`AGENTS.md` mit sinnvollen Regeln (siehe z. B. Immogents bestehende
Quellen-der-Wahrheit-Hierarchie, Definition of Done). Diese Datei enthält
bislang keinen Hinweis auf den Harness. Eine vollständige
Dateiersetzung nach dem Muster der Workflow-Vorlagen aus REQ-006 ist hier
nicht angemessen, weil dabei bestehender, wertvoller
Repository-spezifischer Inhalt verloren ginge oder mit jedem Update
riskiert würde.

## Nutzer-Outcome

`harness init` fügt einen klar abgegrenzten, versionierten Kontextblock in
die `AGENTS.md` des Zielrepositories ein bzw. aktualisiert ihn — ohne
bestehenden Inhalt außerhalb dieses Blocks zu verändern. Existiert noch
keine `AGENTS.md`, wird sie mit ausschließlich diesem Block neu angelegt.
Jeder Agent, der die Datei liest, erfährt dadurch sofort: dass dieses
Repository vom Harness orchestriert wird, wo der kanonische
Fortschrittsstand zu finden ist, wie er vor eigenständiger Arbeit prüft,
ob bereits ein Tracking-Issue existiert, und was die relevanten Label
bedeuten.

## Akzeptanzkriterien

- AC-01: `harness init --install-agents-context` fügt einen durch
  eindeutige Start-/Endmarker abgegrenzten, versionierten Block in die
  `AGENTS.md` des Zielrepositories ein.
- AC-02: Existiert die Datei nicht, wird sie mit ausschließlich diesem
  Block neu angelegt.
- AC-03: Existiert die Datei bereits mit beiden Markern, wird
  ausschließlich der Inhalt zwischen den Markern ersetzt; jeglicher Inhalt
  davor und danach bleibt byteidentisch erhalten.
- AC-04: Existiert die Datei bereits ohne Marker, wird der Block ergänzt,
  ohne bestehenden Inhalt zu verändern, zu löschen oder umzusortieren.
- AC-05: Ist nur einer der beiden Marker vorhanden (beschädigter/manuell
  fehlerhaft bearbeiteter Zustand), wird nichts geschrieben; stattdessen
  wird ein sichtbarer Konflikt gemeldet.
- AC-06: Der Block benennt mindestens: dass der Harness diesen Prozess
  orchestriert, wo der kanonische Run-State liegt (Tracking-Issue,
  `harness:run`), wie ein Agent vor eigenständiger Arbeit prüft, ob
  bereits Fortschritt existiert, die Bedeutung der zentralen Label
  (`ai:allowed`, `status:ready`, `status:needs-human`, `harness:run`,
  `harness:implementation`, `harness:gate-approved`/`-rejected`), und
  einen Verweis auf ausführlichere Dokumentation im Harness-Repository.
- AC-07: Wiederholte Ausführung mit unverändertem Block-Inhalt verändert
  die Datei nicht (Idempotenz).
- AC-08: Die Installation ist unabhängig von `--install-workflows`
  aufrufbar und mit ihr kombinierbar, ohne dass sich beide gegenseitig
  beeinflussen.

## Nicht-Ziele

- Ersetzen oder Bewerten von bestehendem, produktspezifischem Inhalt einer
  vorhandenen `AGENTS.md`,
- Generieren einer vollständigen `AGENTS.md` mit Meinungen zu
  Produkt-Code-Stil oder -Architektur,
- Unterstützung mehrerer unterschiedlicher, gleichzeitig verwalteter
  Blöcke in derselben Datei in dieser ersten Ausbaustufe (nur genau ein
  Harness-Kontextblock),
- automatische Aktualisierung bei jedem Commit; die Aktualisierung
  erfolgt ausschließlich bei explizitem `harness init`
  `--install-agents-context`-Aufruf,
- automatische Migration zwischen künftigen Blockversionen in dieser
  ersten Ausbaustufe (siehe Offene Fragen in SPEC-008).
