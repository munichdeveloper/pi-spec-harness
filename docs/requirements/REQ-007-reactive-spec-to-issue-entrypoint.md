---
id: REQ-007
type: requirement
title: Reaktiver Einstiegspunkt von freigegebener Spec bis freigabebereitem Issue ohne aktiven Run
status: approved
owner: product
risk: medium
created: 2026-08-07
updated: 2026-08-07
---

# REQ-007: Reaktiver Einstiegspunkt von freigegebener Spec bis freigabebereitem Issue ohne aktiven Run

## Problem

REQ-003/SPEC-003 beschreiben, wie der Harness einen bereits **laufenden**
Run von einer Spec-Freigabe bis zum Implementierungs-Issue fortsetzt. Sie
setzen voraus, dass zuvor `harness init` für diesen Run bereits ausgeführt
wurde. Es gibt bislang keinen reaktiven Einstiegspunkt, der ganz ohne
vorherigen `harness init`-Aufruf allein durch das Mergen einer
freigegebenen Spec nach `main` selbstständig ein Issue erzeugt — analog zu
REQ-004 (Bug-Track), der ganz ohne aktiven Run allein durch ein neues
`Bug`-Issue ausgelöst wird.

Diese Lücke wurde im Referenzprojekt Immogent unabhängig vom Harness
geschlossen: `spec-to-issue.yml` (Job `auto-create-issue`) erzeugt beim
Push einer freigegebenen Spec automatisch ein Issue über ein
Immogent-lokales Python-Skript, und `harness-approve-for-agent.yml`
bündelt die anschließende menschliche Freigabe dreier Label
(`status:ready`, `ai:allowed`, `harness:implementation`) zu einem
einzigen Klick auf `harness:approved-for-agent`. Beides dupliziert
Fähigkeiten, die konzeptionell zum Harness gehören, und muss aktuell in
jedem weiteren Referenzprojekt erneut nachgebaut werden. Ein
Übergangs-Idempotenzmechanismus (Suche nach der Spec-ID im Issue-Titel)
verhindert zwar aktuell doppelte Issues zwischen Immogents Automatisierung
und einem parallel über die Harness-CLI laufenden Run, ersetzt aber nicht
eine einzige, zentral gepflegte Implementierung.

## Nutzer-Outcome

Sobald eine Software-Spec mit `status: approved` in einem angebundenen
Repository nach `main` gelangt (ganz ohne vorherigen `harness
init`-Aufruf), erzeugt eine vom Harness bereitgestellte, wiederverwendbare
GitHub-Action-Pipeline automatisch das zugehörige Implementierungs-Issue
mit vollständigem Scope, Requirements-Bezug und Definition of Ready. Ein
Mensch kann die Bearbeitung anschließend über einen einzigen Klick
freigeben (ein Bündel-Label), statt mehrere Einzel-Label von Hand zu
setzen. Diese Fähigkeit steht über den in REQ-006 beschriebenen
Installationsmechanismus in jedem angebundenen Repository zur Verfügung,
ohne dass der Workflow oder das Erzeugungsskript dort lokal gepflegt
werden müssen.

Mit demselben Klick, der die Freigabe-Label bündelt, entsteht ohne
weiteres Zutun auch der kanonische Harness-Run-State (Tracking-Issue) für
dieses Issue — nicht erst, wenn irgendwann jemand manuell `harness init`
ausführt. Dadurch findet jeder Agent, der später an diesem Issue
weiterarbeitet (mit oder ohne die Harness-CLI selbst zu benutzen),
denselben strukturierten Stand vor, statt Fortschritt nur aus Labels und
PR-Status erraten zu müssen. Welcher Agent oder Mensch die eigentliche
Implementierung übernimmt, bleibt davon unabhängig — der Run-State ist ein
passiver, lesbarer Datensatz, kein Zwang zur Nutzung der Harness-CLI.

## Akzeptanzkriterien

- AC-01: Ein `push` nach `main`, der eine Datei unter dem
  projektspezifisch konfigurierten Spec-Verzeichnis ändert, löst die
  Pipeline aus; Änderungen außerhalb dieses Verzeichnisses lösen nichts
  aus.
- AC-02: Die Pipeline liest die Spec-Frontmatter (`status`, `id`, `title`,
  `requirements`) und erzeugt nur für Specs mit `status: approved` ein
  Issue; alle anderen Zustände werden übersprungen und geloggt.
- AC-03: Das erzeugte Issue enthält im Titel die Spec-ID in einem stabilen,
  dokumentierten Format sowie im Body Requirements-Bezug, vorgeschlagene
  Arbeitspakete (sofern in der Spec vorhanden) und eine Definition of
  Ready — inhaltlich mindestens gleichwertig zum bisherigen
  Immogont-lokalen `create_issue_from_spec.py`.
- AC-04: Vor dem Erzeugen prüft die Pipeline, ob bereits ein offenes oder
  geschlossenes Issue existiert, dessen Titel dieselbe Spec-ID enthält
  (unabhängig davon, ob es durch diese Pipeline oder durch einen über die
  Harness-CLI laufenden Run erzeugt wurde); ist das der Fall, wird kein
  zweites Issue erzeugt.
- AC-05: Ein zweiter, unabhängig auslösbarer Schritt bündelt beim Setzen
  eines konfigurierbaren Freigabe-Labels (Default
  `harness:approved-for-agent`) auf einem durch AC-03 erzeugten Issue die
  Ziel-Label (Default `status:ready`, `ai:allowed`,
  `harness:implementation`) in einer einzigen Aktion.
- AC-05a: Derselbe Schritt legt non-interaktiv (ohne Chat-Sitzung, ohne
  manuellen CLI-Aufruf durch einen Menschen) einen Harness-Run inklusive
  Tracking-Issue an, sofern für dieses Implementierungs-Issue noch kein
  Run existiert. Der Run-State bindet Requirement- und Spec-Referenz aus
  der Spec-Frontmatter sowie die Implementierungs-Issue-Nummer.
- AC-05b: Existiert für dieses Implementierungs-Issue bereits ein Run
  (z. B. weil zuvor manuell `harness init` ausgeführt wurde), wird kein
  zweiter Run und kein zweites Tracking-Issue angelegt; der bestehende
  Run wird unverändert weiterverwendet.
- AC-05c: Das automatische Anlegen des Runs zwingt keinen Agenten zur
  Nutzung der Harness-CLI für die eigentliche Implementierung; ein Agent,
  der das Issue direkt anhand seiner Label bearbeitet, bleibt weiterhin
  unterstützt. Der Run-State dient ausschließlich als für jeden Agenten
  lesbarer, gemeinsamer Fortschrittsstand.
- AC-06: Beide Schritte werden über den generischen
  Installationsmechanismus aus REQ-006 als benannte Vorlagen
  (`spec-to-issue`, `label-approval-bundling`) bereitgestellt und in ein
  Zielrepository installiert.
- AC-07: Wiederholte oder doppelte Trigger-Events (z. B. erneuter Push
  ohne inhaltliche Änderung, Label erneut gesetzt) erzeugen kein zweites
  Issue und keine doppelte Label-Aktion.
- AC-08: Das erzeugte Issue trägt zunächst keine Ausführungs-Label
  (`status:ready`/`ai:allowed`); diese entstehen ausschließlich über das
  in AC-05 beschriebene menschliche Freigabe-Gate oder über einen
  parallel laufenden Harness-Run (REQ-003), nie automatisch beim Erzeugen.
- AC-09: Die Pipeline funktioniert identisch in jedem Repository, das die
  Vorlagen über REQ-006 installiert hat, ohne repository-spezifische
  Anpassungen im Harness-Kern; projektspezifische Parameter (Spec-Pfad,
  Label-Namen) werden ausschließlich über die installierte Referenzdatei
  konfiguriert.

## Nicht-Ziele

- automatisches Setzen von `status:ready`/`ai:allowed` direkt beim
  Erzeugen des Issues (bleibt ein separates Gate, siehe AC-08),
  Zerlegung einer Spec in mehrere kleinere Issues (weiterhin manuelle
  fachliche Prüfung vor Implementierungsstart, wie bisher),
- Ersatz des bestehenden CLI-gesteuerten Pfads (REQ-003) für Runs, die
  bereits über `harness init` laufen,
- Migration von Immogents heutigen, lokal gepflegten Workflows als
  automatischer Nebeneffekt dieses Requirements (bleibt ein separater,
  bewusster Schritt pro Repository).
