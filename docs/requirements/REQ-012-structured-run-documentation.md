---
id: REQ-012
type: requirement
title: Verlustsichere strukturierte Run-Dokumentation
status: approved
owner: product
risk: high
created: 2026-08-18
updated: 2026-08-18
---

# REQ-012: Verlustsichere strukturierte Run-Dokumentation

## Problem

Run-Dokumentation wird heute teilweise als umfangreiche Prosa manuell im
Vault gepflegt. Dadurch können Referenzen und tatsächlich vorhandene
Run-Dokumente auseinanderlaufen. Der in
[Issue #29](https://github.com/munichdeveloper/pi-spec-harness/issues/29)
dokumentierte Befund zeigt dies konkret: Im Immogent-Vault werden RUN-005 bis
RUN-007 erwähnt, obwohl nur RUN-001 bis RUN-004 und RUN-008 als Run-Dokumente
existieren. RUN-007 wird zusätzlich sowohl für Harness- als auch für
Immogent-Prozesse verwendet.

Der kanonische Run-State lebt bereits im persistenten Tracking-Issue; der
chronologische Ereignisnachweis liegt im Prozess-Audit. Ein weiteres manuell
gepflegtes Protokoll darf diese beiden Quellen nicht duplizieren oder durch
unbelegte Erzählung ersetzen.

## Nutzer-Outcome

Für jeden neuen Harness-Run entsteht nach seinem tatsächlichen Abschluss
automatisch ein lesbarer, deterministischer Markdown-Snapshot im Vault. Der
Snapshot ist eindeutig mit Repository und Tracking-Issue verknüpft, lässt sich
auf GitHub und in Obsidian chronologisch durchsuchen und enthält ausschließlich
belegbare strukturierte Informationen. Ein Run gilt erst dann als vollständig
abgeschlossen, wenn dieser Dokumentationseffekt auf dem Default-Branch
bestätigt und nach REQ-005 auditiert wurde.

Historische Run-Dokumente bleiben erhalten. Fehlende oder mehrdeutige
Legacy-Runs werden ausschließlich evidenzbasiert und ausdrücklich als
rekonstruiert beziehungsweise unbekannt gekennzeichnet.

## Quellen der Wahrheit

- Das persistente GitHub-Tracking-Issue enthält den kanonischen aktuellen
  Run-State.
- Das Prozess-Audit nach REQ-005 ist der unveränderliche chronologische
  Ereignisnachweis.
- Das generierte RUN-Dokument ist eine deterministische, lesbare Projektion
  dieser Quellen und niemals eine dritte manuell gepflegte Prozesswahrheit.

## Akzeptanzkriterien

- AC-01: Neue Runs verwenden die Nummer ihres persistenten Tracking-Issues als
  repositorylokale Kennung (`RUN-<issue-number>`, mindestens vierstellig
  dargestellt). Die global eindeutige Identität enthält zusätzlich das
  Repository, beispielsweise `munichdeveloper/pi-spec-harness#RUN-0056`.
- AC-02: Die RUN-ID wird erst finalisiert, nachdem das Tracking-Issue
  tatsächlich existiert. Produkt- und Harness-Runs besitzen keine gemeinsame
  manuell verwaltete Nummernfolge.
- AC-03: Während des Runs bleibt das Tracking-Issue die operative Quelle. Jeder
  Prozessschritt wird unmittelbar nach REQ-005 auditiert; ein Markdown-Snapshot
  wird erst beim nachgewiesenen Abschluss materialisiert.
- AC-04: Die Phase `complete` darf erst erreicht und das Tracking-Issue erst
  geschlossen werden, nachdem der Snapshot auf `origin/<default-branch>`
  bestätigt und der zugehörige Audit-Effekt zugestellt wurde.
- AC-05: Der Snapshot enthält mindestens Run-Identität, Repository, Start- und
  Abschlusszeitpunkt, Requirement, Spec, Issues, PRs, gebundene Commit-SHAs,
  Entscheidungen, Gates, Iterationen, Review-Befunde, Verifikations- und
  Deployment-Evidenz, Harness-Version und Endergebnis, soweit diese Werte in
  den kanonischen Quellen belegt sind.
- AC-06: Der Generator formuliert keine freie Erzählung und ergänzt keine
  unbekannten Werte. Nicht belegbare Felder bleiben `null` oder werden als
  unbekannt ausgewiesen.
- AC-07: Optionaler menschlicher Rückblick lebt in einer separaten
  `*-notes.md`-Datei. Der Harness erstellt oder überschreibt diese Datei nie.
- AC-08: Generierte Snapshots liegen in einem konfigurierbaren generierten
  Run-Verzeichnis. Der Default ist `docs/runs/generated`; Zielrepositories
  dürfen beispielsweise `docs/50-quality/runs/generated` konfigurieren.
- AC-09: Der Harness erzeugt einen deterministischen, chronologisch absteigend
  sortierten Markdown-Index und eine Obsidian-Base aus standardisiertem
  YAML-Frontmatter. Die Markdown-Ansicht funktioniert ohne Obsidian; die Base
  benötigt kein Community-Plugin.
- AC-10: Ein Reconciler erkennt einen fehlenden oder nur vorbereiteten
  Snapshot-Effekt und liefert ihn mit begrenzten, idempotenten Wiederholungen
  nach. Wiederholungen dürfen keine doppelten Run-Dateien erzeugen.
- AC-11: Nach wiederholt fehlgeschlagener Zustellung bleibt der Run vor
  `complete` stehen und öffnet ein verständliches `HUMAN-NEEDED`-Gate mit der
  konkret fehlenden Berechtigung oder dem Writer-Fehler.
- AC-12: Neue unqualifizierte Run-Referenzen, doppelte Identitäten,
  widersprüchliche Statuswerte, ungültiges Frontmatter und terminale Runs ohne
  bestätigten Snapshot werden automatisiert erkannt. Audit-Ereignisse aktiver
  Runs sind von der Snapshot-Existenzprüfung ausgenommen.
- AC-13: Der Writer arbeitet ausschließlich mit dem repositorygebundenen
  `GITHUB_TOKEN` und minimaler Berechtigung `contents: write`. Es gibt keinen
  Fallback auf persönliche Tokens oder einen vergessbaren Dokumentations-PR.
- AC-14: Die Capability Attestation prüft vor dem produktiven Run, ob der
  Default-Branch den direkten, eingeschränkten Writer akzeptiert und ob der
  bestehende Audit-Vertrag nach REQ-005 verfügbar ist.
- AC-15: Snapshots enthalten keine Secrets, Cookies, Tokens, Mailinhalte,
  personenbezogenen Testdaten oder Prompt-Rohdaten. Evidence-URLs werden ohne
  Query-Parameter gespeichert; unbekannte Felder werden abgewiesen.
- AC-16: Vor einem Commit werden Schema-, Pfad-, Datenhygiene- und
  Secret-Prüfung ausgeführt. Der Writer darf nur den vorgesehenen Snapshot und
  die beiden Run-Ansichten verändern.
- AC-17: RUN-005 bis RUN-007 werden im Immogent-Vault evidenzbasiert unter
  `reconstructed/` klassifiziert. Harness- und Immogent-Ereignisse zu RUN-007
  werden als zwei getrennte repositoryqualifizierte Legacy-Runs behandelt.
- AC-18: Bestehende RUN-001 bis RUN-004 und RUN-008 behalten Inhalt und
  Dateinamen. Ihr Frontmatter wird nur um belegbare Felder sowie
  `generated: false` und `legacy: true` ergänzt; unbekannte Werte werden nicht
  geschätzt.
- AC-19: Die Harness-Funktion und die Immogent-Migration werden als zwei
  getrennte Lieferungen umgesetzt. Issue #29 bleibt offen, bis beide
  Lieferungen nachgewiesen sind.
- AC-20: Die Harness-Lieferung beweist sich selbst: Nach dem Merge erzeugt der
  neue Writer den Snapshot und die Ansichten des eigenen REQ-012/SPEC-012-Runs,
  bestätigt sie auf dem Default-Branch und schließt erst danach den Run ab.
- AC-21: Snapshot und Indizes werden vollständig deterministisch ohne LLM,
  externe Datenbank oder zusätzliche SaaS-Komponente erzeugt.

## Nicht-Ziele

- nachträgliches Erfinden vollständiger Protokolle für Legacy-Runs,
- Ersetzen des Tracking-Issues als kanonischer aktueller Run-State,
- Ersetzen oder Abschwächen des verlustsicheren Prozess-Audits,
- KI-generierte Zusammenfassungen in produktiven Snapshots,
- manuelles Pflegen eines separaten RUN-Zählers,
- ungeprüfter direkter Push beliebiger Dateien auf den Default-Branch,
- Einführung einer zentralen persönlichen oder repositoryübergreifenden
  Schreibidentität,
- gleichzeitige Änderung der Immogent-Legacy-Dokumente im Harness-Code-PR.

## Abhängigkeiten

- persistenter Run-State im Tracking-Issue und reine State-Machine aus REQ-001,
- autonome Orchestrierung und Run-Abschluss aus REQ-003,
- verlustsicherer Audit-Vertrag aus REQ-005,
- installierbare Workflow-Vorlagen aus REQ-006,
- Agent-Capability-Attestation aus REQ-010,
- Reconciler und Stall-Watchdog aus REQ-002 und REQ-011.

## Kostenrahmen

Die Erzeugung verwendet ausschließlich TypeScript/Node.js, GitHub Actions und
die bereits repositorygebundene Infrastruktur. Sie ruft kein Modell auf und
führt keine neue kostenpflichtige Komponente ein. KI darf Implementierung und
Review unterstützen, aber keine produktiven Snapshot-Inhalte frei erzeugen.
