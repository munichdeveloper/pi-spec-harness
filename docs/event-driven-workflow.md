# Event-driven harness workflow

## Ziel

Ein Run kann ohne offene Chat-Sitzung fortgesetzt werden. GitHub-Issues
enthalten den kanonischen Zustand, GitHub-Labels tragen menschliche
Entscheidungen und eng begrenzte Actions führen genau den betroffenen Run
weiter.

Die Automation darf niemals das „neueste“ Issue, die höchste Spec oder den
zuletzt geöffneten PR auswählen.

## Kanonische Zuordnung

Ein Slice besitzt:

1. genau ein Tracking-Issue mit `harness:run`,
2. genau eine Run-ID im State-Block dieses Issues,
3. eine Spec-ID im Run-State,
4. höchstens ein Implementierungs-Issue mit `harness:implementation`,
5. höchstens einen gebundenen PR samt vollständigem Head-SHA.

Das Implementierungs-Issue enthält zusätzlich:

```text
Harness Run: `<run-id>`
Tracking Issue: #<number>
Spec: `docs/.../<SPEC-ID>-....md`
```

## Ereigniskette

### Spec-Freigabe

1. Mensch setzt `harness:gate-approved` oder `harness:gate-rejected` auf dem
   Tracking-Issue.
2. `harness-gate-trigger.yml` liest die Run-ID ausschließlich aus genau
   diesem Issue.
3. `harness resume` übernimmt die Entscheidung und entfernt transiente
   Labels.
4. Bei Freigabe darf `harness advance` genau eine Phase weiterschalten.
5. Nur ein Gate mit ID `spec-approval` dispatcht die Issue-Erstellung mit
   expliziter Run-ID und Tracking-Issue-Nummer.

Eine Spec-Datei oder ein Spec-PR wird nicht anhand von Sortierung oder
Aktualitätsannahmen verändert. Eine solche Mutation benötigt eine eigene,
eindeutige Bindung.

### Implementierungs-Issue

`harness-issue-create-trigger.yml` akzeptiert ausschließlich einen expliziten
`workflow_dispatch`:

- `run_id`
- `tracking_issue`

Der Workflow validiert das Tracking-Issue, liest die Spec-ID aus dem
Run-State und verlangt genau eine passende Spec-Datei. Das neue Issue erhält
`harness:implementation`, `ai:allowed` und `status:ready`, aber niemals
`harness:run`.

### PR-Verifikation

Ein PR wird über seine Referenz zum Implementierungs-Issue seinem Run
zugeordnet. Verification wird erst bestanden, wenn:

- der PR kein Draft ist,
- der aktuelle Head-SHA im Run-State gebunden wurde,
- alle sichtbaren PR-Checks abgeschlossen und erfolgreich oder übersprungen
  sind,
- kein nicht veralteter, ungelöster Review-Thread existiert.

Evidence enthält den konkreten PR, Head-SHA und Action-Link. Ein neuer
Head-SHA setzt Review-Evidence auf `pending` zurück.

### Merge

Nach erfolgreicher Verifikation öffnet der Workflow ein SHA-spezifisches
Human-Gate. Nach Freigabe darf `harness-gate-trigger.yml` ausschließlich den
im State gespeicherten PR mergen, wenn dessen aktueller Head noch exakt dem
gespeicherten SHA entspricht und die erforderlichen Checks grün sind.

### Fehler und Recovery

Bei fehlgeschlagenen Checks:

1. PR und Head-SHA stammen ausschließlich aus dem `workflow_run`-Payload.
2. Der Head wird als
   `recovery/<run>-pr-<number>-<short-sha>` bewahrt.
3. `main` bleibt unverändert.
4. Pro Head-SHA wird genau eine fehlgeschlagene Iteration gebucht.
5. Unterhalb des Limits darf der Implementierungsagent erneut getriggert
   werden.
6. Ab drei Fehlschlägen öffnet sich `needs-human-escalation`; es findet kein
   vierter automatischer Versuch statt.

## Menschliche Aufgaben

Der Mensch muss im Normalfall nur:

- fachliche oder risikorelevante Gates entscheiden,
- das Merge-Gate bei mittlerem oder hohem Risiko entscheiden,
- eine Eskalation nach drei Fehlschlägen beurteilen.

Kommentare dienen als Kontext. Formal zählen nur die beiden Gate-Labels.

## Betriebsprüfung

- Action-Run gehört zum erwarteten Tracking-Issue.
- State nennt die erwartete Run-ID, Spec, Implementierungs-Issue, PR und SHA.
- CI und Workflow-Vertragstests sind grün.
- Kein Workflow enthält direkte Pushes nach `main`.
- Keine Workflow-Auswahl verwendet `tail -1`, `sort -V`, `--limit 1` oder
  eine Suche nach dem „most recent“ Objekt.

