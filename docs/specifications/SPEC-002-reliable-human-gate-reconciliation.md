---
id: SPEC-002
type: software-spec
title: Dauerhafte Human-Gate-Entscheidungen und Event-Reconciliation
status: approved
owner: engineering
risk: high
requirements:
  - REQ-002
implementation_assignee: "@github-copilot"
created: 2026-07-30
updated: 2026-07-30
---

# SPEC-002: Dauerhafte Human-Gate-Entscheidungen und Event-Reconciliation

## Zusammenfassung

Das Human-Gate-Protokoll wird von einer rein zustandsbasierten Label-Abfrage
zu einem dauerhaften, gate-spezifischen Entscheidungsprotokoll erweitert.
Label-Events werden anhand des Öffnungszeitpunkts dem konkreten Gate
zugeordnet. Der Run-State wird vor externem Cleanup gespeichert. Ein
idempotenter Reconciliation-Befehl kann verpasste Events nachholen.

Der bestehende Event-Workflow bleibt der schnelle Standardpfad. Zusätzlich
unterstützt er einen manuellen Dispatch und eine einmalige Reconciliation,
wenn der Workflow auf dem Default-Branch installiert oder geändert wird.
Periodisches Polling ist nicht Teil des Standards.

## Technische Entscheidungen

1. GitHub-Issue und kanonischer JSON-State bleiben die einzige persistente
   State-Quelle; kein zusätzlicher Dienst wird eingeführt.
2. `GateRecord` erhält dauerhaften Entscheidungskontext sowie einen expliziten
   Öffnungszeitpunkt. PR und Head-SHA stammen weiterhin aus `RunState`.
3. Die GitHub-Anbindung liest Label-Timeline-Events mit Actor und Zeitpunkt.
   Ein vorhandenes Label ohne gültiges Event nach `openedAt` zählt nicht.
4. State-Persistenz und GitHub-Aufräumaktionen werden getrennt: Persistenz ist
   verbindlich, Kommentare und Label-Cleanup sind idempotente Folgeaktionen.
5. `reconcile` durchsucht ausschließlich offene Tracking-Issues mit
   `harness:run` und `harness:gate-open` im explizit angegebenen Repository.
6. Der Workflow serialisiert Gate-Verarbeitung repositoryweit über eine
   Concurrency-Gruppe.
7. Reconciliation wird eventgetrieben, per `workflow_dispatch` und bei
   Installation beziehungsweise Änderung des Workflows auf dem Default-Branch
   ausgeführt; kein Standard-Cron und damit keine dauerhaften Runner-Kosten.

## Technische Akzeptanzkriterien

- TAC-01: `GateRecord` speichert `context`, `openedAt` und die für eine
  verständliche Entscheidung erforderlichen strukturierten Angaben.
- TAC-02: `renderStateBody` zeigt für das offene Gate Scope, Kriterien,
  Evidence, Risiken, Nicht-Ziele, Folgeaktion sowie bei PR-Gates PR und volle
  Head-SHA.
- TAC-03: `gate-open` bereinigt beide Decision-Labels idempotent, persistiert
  das vorbereitete Gate und veröffentlicht danach den offenen Gate-Zustand.
- TAC-04: Der GitHub-Adapter kann Label-Timeline-Events mit Label, Actor und
  `createdAt` für das Tracking-Issue lesen.
- TAC-05: `resume` akzeptiert nur eine eindeutige Decision, deren Event nicht
  vor `openedAt` liegt. Zwei gültige gegensätzliche Events erzeugen einen
  blockierenden Konflikt.
- TAC-06: `resume` speichert `passed` oder `failed` einschließlich Actor und
  Event-Zeitpunkt, bevor es Kommentare schreibt oder Labels entfernt.
- TAC-07: Nach einem Persistenzerfolg beeinträchtigt ein Cleanup-Fehler die
  Gate-Entscheidung nicht; ein späterer Lauf kann das Cleanup wiederholen.
- TAC-08: Ein idempotenter CLI-Befehl `reconcile --repository <owner/repo>`
  findet ausschließlich offene Harness-Gates und führt für jeden Run das
  äquivalente `resume` aus.
- TAC-09: `harness-gate-trigger.yml` unterstützt `issues:labeled`,
  `workflow_dispatch` sowie einen Default-Branch-Push für seine eigene
  Installation oder Änderung.
- TAC-10: Der Workflow validiert den kanonischen Run-Header, verwendet keine
  Auswahl nach „neuestem“ Issue und serialisiert Verarbeitung
  repositoryweit.
- TAC-11: Ein Merge-Gate kann nur geöffnet werden, wenn ein vollständiger
  PR-Checkpoint gebunden ist; ein neuer Head invalidiert die alte Freigabe.
- TAC-12: Tests simulieren mindestens:
  altes Decision-Label, verpasstes Event, doppelte Zustellung,
  Approved/Rejected-Konflikt, Fehler vor Persistenz, Cleanup-Fehler nach
  Persistenz, Workflow-Bootstrap und vollständige Gate-Darstellung.

## Verifikation

- `npm run check`,
- neue Human-Gate- und Reconciliation-Unit-Tests,
- GitHub-Adaptertests mit deterministischen Timeline-Fixtures,
- Workflow-Vertragstests für alle Trigger und Concurrency,
- isolierter GitHub-Smoke-Run mit absichtlich verpasstem Label-Event,
- Review ohne offene umsetzbare Threads,
- SHA-spezifisches Human Merge Gate.

## Rollback

Die Änderung wird als eigener PR ausgeliefert. Bei einem Fehler kann der PR
normal revertiert werden. Der kanonische Issue-State bleibt lesbar; neue
optionale Gate-Felder sind rückwärtskompatibel. Der bestehende manuelle
`resume`-Pfad bleibt als Recovery-Möglichkeit erhalten.
