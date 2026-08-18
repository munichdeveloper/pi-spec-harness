---
id: SPEC-012
type: software-spec
title: Verlustsichere strukturierte Run-Dokumentation
status: approved
owner: engineering
risk: high
requirements:
  - REQ-012
implementation_assignee: "@github-copilot"
created: 2026-08-18
updated: 2026-08-18
---

# SPEC-012: Verlustsichere strukturierte Run-Dokumentation

## Zusammenfassung

Der Harness materialisiert nach einem nachgewiesenen Delivery-Merge eine
deterministische Markdown-Projektion des kanonischen Run-States. Der
Snapshot-Effekt ist ein persistenter, idempotenter Abschluss-Checkpoint: Der
Run verbleibt in der Phase `merge`, bis Snapshot und Run-Ansichten auf dem
Default-Branch sowie der Audit-Effekt nach REQ-005 bestätigt wurden. Erst dann
erfolgt der bestehende Übergang nach `complete` und das Tracking-Issue wird
geschlossen.

Neue RUN-IDs werden aus der Nummer des persistenten Tracking-Issues gebildet.
Historische Dokumente werden nicht vom Generator überschrieben. Eine zweite,
separate Immogent-Migration klassifiziert RUN-005 bis RUN-007 und ergänzt das
Frontmatter vorhandener Legacy-Dokumente.

Quelle des Befunds ist
[pi-spec-harness Issue #29](https://github.com/munichdeveloper/pi-spec-harness/issues/29).

## Technische Entscheidungen

### 1. Kanonische Run-Identität

Die neue Hilfsfunktion `formatCanonicalRunId(repository, trackingIssue)`
liefert:

```ts
{
  runId: "RUN-0056",
  qualifiedRunId: "munichdeveloper/pi-spec-harness#RUN-0056",
  processInstance: "PI-MUNICHDEVELOPER-PI-SPEC-HARNESS-RUN-0056"
}
```

Die Dezimaldarstellung wird mit mindestens vier Stellen formatiert und bei
größeren Issue-Nummern nicht gekürzt.

Da GitHub die Issue-Nummer erst nach dem Erstellen zurückgibt, wird ein neues
Tracking-Issue zweiphasig veröffentlicht:

1. Das Issue wird ohne `harness:run`-Label mit einem stabilen
   Bootstrap-Marker erstellt.
2. Nach Rückgabe der Issue-Nummer werden `runId`, qualifizierte Identität,
   Titel und kanonischer State finalisiert.
3. Das Label `harness:run` wird als letzter Veröffentlichungseffekt gesetzt.

Ein abgebrochener Bootstrap ist dadurch nicht als aktiver Run sichtbar. Ein
Retry findet das Issue über den stabilen Marker und finalisiert dasselbe Issue,
statt ein zweites anzulegen. Bestehende Run-IDs bleiben unverändert und werden
nicht nachträglich an Issue-Nummern angepasst.

### 2. Additiver Dokumentations-Checkpoint im Run-State

`RunState` erhält rückwärtskompatibel:

```ts
interface DocumentationSnapshotCheckpoint {
  schemaVersion: 1;
  status: "prepared" | "publishing" | "persisted";
  idempotencyKey: string;
  path: string;
  indexPath: string;
  obsidianBasePath: string;
  generatedAt: string;
  sourceHeadSha: string;
  commitSha?: string;
  auditIdempotencyKey: string;
  auditConfirmedAt?: string;
}

interface RunState {
  // bestehende Felder
  documentationSnapshot?: DocumentationSnapshotCheckpoint;
}
```

Das Feld bleibt für bestehende States optional; `schemaVersion` des
Run-States bleibt wegen der rein additiven, rückwärtskompatiblen Änderung bei
seinem bestehenden Wert. Der Snapshot besitzt unabhängig davon
`schema_version: 1`.

`generatedAt`, Pfade, Source-SHA und beide Idempotency Keys werden im Zustand
persistiert, bevor ein externer Schreibeffekt startet. Damit rendert jeder
Retry byteidentischen Inhalt.

### 3. Abschlussreihenfolge

Der bestehende Übergang `merge -> complete` verlangt künftig zusätzlich zu
der bestätigten Merge-Evidenz:

1. `documentationSnapshot.status === "persisted"`,
2. einen vollständigen `commitSha`,
3. Bestätigung, dass dieser Commit beziehungsweise identische Inhalte auf
   `origin/<default-branch>` vorhanden sind,
4. `auditConfirmedAt` für den idempotenten Dokumentationseffekt.

`computeNextAction()` bleibt rein. Bei bestätigtem Merge und fehlendem
Snapshot liefert sie eine neue deterministische Aktion
`persist-run-documentation`. Die CLI beziehungsweise Orchestrierung führt die
Seiteneffekte aus. Erst ein danach erneut berechneter Zustand darf
`advance-phase` nach `complete` liefern.

### 4. Deterministische Snapshot-Projektion

Neues Modul `src/documentation/run-snapshot.ts`:

```ts
renderRunSnapshot(input: {
  state: RunState;
  trackingIssue: HumanGateIssueRef;
  repositoryDefaultBranch: string;
  harnessVersion: string;
}): string
```

Die Funktion ist rein, sortiert Mengen stabil und rendert ausschließlich
allowlistete Felder aus dem Run-State. Der Snapshot enthält YAML-Frontmatter
und klar gekennzeichnete Abschnitte für:

- Identität, Status und Zeitpunkte,
- Requirement, Spec und Tracking-Issue,
- Implementierungs- und Delivery-Issues/PRs samt vollständigen SHAs,
- Gates und menschliche Entscheidungen,
- Iterationen, Reviews und Review-Threads,
- Test-, CI-, Preview-, Deployment- und Merge-Evidenz, soweit strukturiert
  vorhanden,
- Harness-Version und Snapshot-Quell-SHA,
- Audit-Korrelation und Ergebnis.

Freitext wird nicht zusammengefasst. Unbekannte optionale Werte werden als
`null` oder `unknown` dargestellt. Notes werden höchstens als vorhandene
strukturierte Notizen zitiert; es wird keine neue Erzählung erzeugt.

### 5. Pfade, Dateinamen und manuelle Notes

Neue Konfiguration:

```ts
interface RunDocumentationConfig {
  generatedDirectory: string; // Default "docs/runs/generated"
  indexPath: string;           // Default "docs/runs/RUN-INDEX.md"
  obsidianBasePath: string;    // Default "docs/runs/Runs.base"
  legacyDirectories: string[]; // Default ["docs/runs"]
}
```

Der Dateiname lautet
`<RUN-ID>-<slugified-spec-or-title>.md`. Die Pfade werden relativ zur
Repositorywurzel normalisiert; absolute Pfade, `..`, Symlinks außerhalb des
Repositories und Pfade außerhalb der konfigurierten Allowlist werden
abgewiesen.

Eine gleichnamige Datei mit Suffix `-notes.md` ist ausschließlich menschlich
verwaltet. Writer, Indexgenerator und Reconciler lesen ihr optionales
Vorhandensein, verändern sie aber nie.

### 6. Markdown-Index und Obsidian Base

`src/documentation/run-index.ts` liest ausschließlich validiertes Frontmatter
aus generierten Snapshots und konfigurierten Legacy-Verzeichnissen.

- `RUN-INDEX.md` wird deterministisch nach `completed_at`, ersatzweise
  `updated`, absteigend sortiert. Gleichstände werden über qualifizierte Run-ID
  und Pfad aufgelöst.
- Der Index unterscheidet `generated`, `legacy` und `legacy-reconstructed` und
  zeigt Repository, Status, Spec, Tracking-Issue und Abschlusszeitpunkt.
- `Runs.base` ist eine statische, deterministisch gerenderte Obsidian-Core-Base,
  die dasselbe Frontmatter filter- und sortierbar darstellt.
- Der Generator benötigt Obsidian nicht zur Ausführung; ein Contract-Test
  validiert Syntax, Filterpfad und Sortierung.

### 7. Eingeschränkter direkter Writer

Neue benannte GitHub-Adapterfunktionen in `src/github/gh.ts` kapseln alle
Schreibaktionen; ein generischer Shell-/GitHub-Escape-Hatch ist verboten.

Der Writer:

1. checkt den vertrauenswürdigen Default-Branch aus,
2. rendert Snapshot und beide Ansichten in einem temporären Arbeitsstand,
3. führt Schema-, Hygiene-, Secret- und Pfadprüfung aus,
4. staged ausschließlich Snapshot, `RUN-INDEX.md` und `Runs.base`,
5. verweigert den Commit bei jedem weiteren geänderten Pfad,
6. committed mit einer stabilen, auditierbaren Commit-Nachricht,
7. pusht mit `GITHUB_TOKEN` und `contents: write`,
8. bestätigt den Effekt über Idempotency Marker, Pfad, Inhaltshash und
   `origin/<default-branch>`.

Bei konkurrierenden Änderungen fetch/rebased der Writer höchstens dreimal und
rendert die Indizes nach jedem Rebase erneut gegen den aktuellen
Default-Branch. Existiert der identische Effekt bereits, ist der Retry ein
bestätigter No-op. Es gibt keinen PR- oder PAT-Fallback.

### 8. Audit und Transaktionsgrenze

Nach bestätigtem Dokumentations-Commit wird ein Ereignis über den vorhandenen
REQ-005-Envelope v1 zugestellt:

- Prozesskennung: `DOCUMENTATION_UPDATE`,
- Akteur: `GITHUB_ACTIONS`,
- Rolle: `GITHUB_ACTIONS_TOKEN`,
- Korrelation: qualifizierte Run-ID, Tracking-Issue, Delivery-PR,
  Source- und Dokumentations-Commit,
- Begründung und Ergebnis ohne frei generierte Prosa,
- Idempotency Key aus dem vorbereiteten Checkpoint.

Die Audit-Infrastruktur selbst bleibt Bestandteil von REQ-005 und wird in
SPEC-012 nicht dupliziert. Die Capability Attestation prüft vorab, ob der
konfigurierte Recorder erreichbar ist. Ohne bestätigte Audit-Zustellung bleibt
der Run in `merge`; derselbe Effekt wird später idempotent nachgeliefert.

### 9. Reconciliation und Eskalation

Der bestehende Reconciler und der Stall-Watchdog erkennen:

- bestätigten Merge ohne `documentationSnapshot`,
- `prepared` oder `publishing` ohne bestätigten Origin-Effekt,
- `persisted` ohne Audit-Bestätigung,
- auf Origin bereits vorhandenen Effekt bei veraltetem Tracking-State.

Sie setzen den Zustand anhand bestätigter Evidenz fort oder wiederholen die
fehlende begrenzte Aktion. Derselbe Idempotency Key verhindert doppelte
Dateien und Ereignisse. Nach drei fehlgeschlagenen Writer- oder Audit-Versuchen
öffnet der Harness genau ein Human Gate `run-documentation-delivery-failed`
mit Fehlerklasse, betroffenen Pfaden, letzter Run-URL und konkreter
Konfigurationsmaßnahme.

### 10. Validierung und Datenhygiene

Neuer Befehl:

```text
harness run-documentation-validate --repository <owner/repo>
  [--generated-directory <path>]
  [--legacy-directory <path> ...]
```

Er prüft:

- Snapshot-Schema und erlaubte Frontmatter-Felder,
- eindeutige qualifizierte Run-IDs,
- Übereinstimmung von Repository, Tracking-Issue und neuer RUN-ID,
- deterministische Sortierung und Aktualität beider Ansichten,
- keine neuen unqualifizierten RUN-Referenzen außerhalb expliziter
  Legacy-Verzeichnisse,
- keine Begriffe wie `RUN-<n> (Arbeitstitel)`,
- keine terminalen Tracking-States ohne bestätigten Snapshot,
- Secret-, Token-, Cookie-, E-Mail- und personenbezogene Datenmuster,
- Evidence-URLs ohne Query oder Fragment.

Audit-Event-Dateien und aktive Runs werden nicht fälschlich als fehlende
Snapshots bewertet. Unbekannte Frontmatter-Felder und unbekannte
Snapshot-Schema-Versionen führen zu einem Fehler.

### 11. Capability Attestation

SPEC-010 wird um die Capability `run-documentation-writer` ergänzt. Der
read-only Preflight prüft:

- installierten Workflow und gepinnten Harness-Ref,
- `contents: write` für den vorgesehenen Workflow,
- zulässige Zielpfade,
- Default-Branch-Regeln beziehungsweise einen nachweislich erlaubten
  repositorygebundenen Writer,
- verfügbaren REQ-005-Auditvertrag.

Fehlt eine Capability, startet der produktive Run nicht beziehungsweise kann
er nicht nach `complete` wechseln. Der Bericht nennt die konkrete fehlende
Repositoryeinstellung. Es werden weder persönliche Tokens noch Secrets
angefordert oder protokolliert.

### 12. Workflow-Integration und Installation

Der Workflow-Vorlagenkatalog aus SPEC-006 erhält einen verwalteten Eintrag
`run-documentation-finalizer`. Der dünne Zielrepo-Workflow reagiert auf die
bereits vorhandenen Harness-Gate-/PR-/Watchdog-Ereignisse und ruft den neuen
CLI-Pfad nur auf, wenn `computeNextAction()`
`persist-run-documentation` liefert.

Minimale Berechtigungen:

```yaml
permissions:
  contents: write
  issues: write
  pull-requests: read
  actions: read
```

`cancel-in-progress: false` und eine repository- sowie runbezogene
Concurrency-Gruppe verhindern verlorene wartende Effekte. Der Workflow
bezieht keine Secrets per `secrets: inherit`.

## Technische Akzeptanzkriterien

- TAC-01: `formatCanonicalRunId()` bildet Issue 56 exakt auf `RUN-0056`, die
  qualifizierte Identität und den normalisierten Prozessbezeichner ab; Issue
  12345 wird nicht gekürzt.
- TAC-02: Ein Tracking-Issue-Bootstrap erhält `harness:run` erst nach
  erfolgreicher Finalisierung. Ein Retry über denselben Marker verwendet
  dasselbe Issue.
- TAC-03: Bestehende Run-States ohne `documentationSnapshot` werden weiterhin
  gelesen und unverändert round-getripped.
- TAC-04: Ein Zustand in Phase `merge` mit bestätigter Merge-Evidenz, aber
  ohne Snapshot liefert `persist-run-documentation`, nicht `complete`.
- TAC-05: Nur ein auf Origin bestätigter Snapshot mit Audit-Bestätigung erlaubt
  den Übergang nach `complete` und das Schließen des Tracking-Issues.
- TAC-06: `renderRunSnapshot()` erzeugt für dieselbe Eingabe byteidentischen
  Inhalt und stabile Sortierung unabhängig von Eingabereihenfolgen.
- TAC-07: Der Snapshot enthält alle belegten Pflichtfelder; unbekannte Werte
  werden nicht erfunden und unbekannte Eingabefelder werden abgewiesen.
- TAC-08: Eine vorhandene `*-notes.md`-Datei bleibt bei Erzeugung, Retry,
  Reconciliation und Indexaktualisierung byteidentisch.
- TAC-09: Index und Obsidian Base sind deterministisch, chronologisch
  absteigend und enthalten generierte sowie explizit konfigurierte
  Legacy-Dokumente mit ihrer korrekten Klassifikation.
- TAC-10: Der Writer verweigert absolute Pfade, Traversal und Symlink-Escape.
  Er bricht außerdem ab, sobald mehr als die drei vorgesehenen Pfade oder ein
  anderer unerwarteter Pfad gestaged ist.
- TAC-11: Zwei gleiche Zustellungen erzeugen genau einen Snapshot und einen
  Audit-Effekt; der zweite Lauf bestätigt einen No-op.
- TAC-12: Ein simulierter Push-Konflikt wird begrenzt gerebased; der Index wird
  gegen den neuen Default-Branch neu gerendert und verliert keinen
  konkurrierenden Run.
- TAC-13: Drei fehlgeschlagene Zustellungen öffnen genau ein Gate
  `run-documentation-delivery-failed`; ein weiterer Reconcile-Lauf dupliziert
  es nicht.
- TAC-14: Secret-, Credential-, E-Mail-/PII-Muster und Evidence-URLs mit Query
  werden vor jedem Commit abgewiesen.
- TAC-15: `run-documentation-validate` erkennt doppelte IDs,
  Issue/Run-Mismatches, veraltete Indizes, neue unqualifizierte Referenzen und
  `RUN-<n> (Arbeitstitel)`; aktive Audit-Ereignisse erzeugen keinen
  Fehlalarm.
- TAC-16: Die Workflow-Vorlage enthält nur die dokumentierten minimalen
  Berechtigungen, kein `secrets: inherit`, eine nicht stornierende
  Concurrency-Gruppe und den gepinnten Harness-Ref.
- TAC-17: Die Capability Attestation meldet fehlendes `contents: write`,
  inkompatiblen Branch-Schutz oder fehlenden Auditvertrag vor dem
  produktiven Schreibversuch als konkrete Blockade.
- TAC-18: Der Post-Merge-Dogfood-Lauf von SPEC-012 erzeugt seinen eigenen
  Snapshot, aktualisiert beide Ansichten, bestätigt Commit und Audit und
  schließt erst danach das Tracking-Issue.
- TAC-19: Generator, Validator und Indizes führen keinen LLM- oder externen
  SaaS-Aufruf aus.

## Verifikation

- `npm run check`,
- Unit-Tests für Identität, reine Projektion, Sortierung, Hygiene und
  Pfadvalidierung,
- State-Machine-Tests für fehlenden, vorbereiteten, persistierten und
  auditierten Snapshot,
- Issue-Store-Test für zweiphasigen Bootstrap und Retry,
- Contract-Tests für CLI-Ausgabe und unbekannte Schemafelder,
- Writer-Integrationstests mit temporärem Bare-Remote für Push, Konflikt,
  Rebase, No-op und Origin-Bestätigung,
- Workflow-Vertragstest für Trigger, Berechtigungen, Concurrency und
  installierbaren Katalogeintrag,
- Legacy-Fixtures für vorhandene Immogent-Runs und mehrdeutige RUN-007-
  Identitäten,
- Post-Merge-E2E im Harness-Repository gemäß TAC-18.

## Rollout

### Lieferung A: Harness-Funktion

1. REQ-012 und SPEC-012 menschlich freigeben und über den Harness in ein
   exaktes Implementierungs-Issue überführen.
2. State-Checkpoint, reine Generatoren, Validator, eingeschränkten Writer,
   Reconciliation und Workflow-Vorlage implementieren.
3. Capability Attestation um den Writer-Preflight ergänzen.
4. Den Finalizer im Harness-Repository installieren.
5. Nach dem Delivery-Merge den eigenen SPEC-012-Run automatisch materialisieren
   und erst danach abschließen.
6. Eine neue Harness-Version taggen, damit Zielrepositories einen unveränderlichen
   Ref installieren können.

### Lieferung B: Immogent-Migration

1. Die freigegebene Harness-Version in Immogent pinnen und die Writer-
   Capability attestieren.
2. `docs/50-quality/runs/generated/`, `RUN-INDEX.md` und `Runs.base`
   konfigurieren.
3. Bestehende RUN-001 bis RUN-004 und RUN-008 ausschließlich im Frontmatter
   um belegte Felder, `generated: false` und `legacy: true` ergänzen.
4. RUN-005 bis RUN-007 unter `reconstructed/` evidenzbasiert klassifizieren;
   Harness- und Immogent-RUN-007 getrennt halten.
5. `RUN-005 (Arbeitstitel)` in SPEC-015 durch eine geplante Slice-Bezeichnung
   ohne RUN-ID ersetzen.
6. Validator und Ansichten ausführen, Review und Audit abschließen und danach
   Issue #29 schließen.

## Rollback

- Der Finalizer-Workflow kann deaktiviert werden; bereits erzeugte Snapshots
  und Audit-Evidenz bleiben erhalten.
- Ein Run mit vorbereitetem Snapshot bleibt sicher in `merge` und kann nach
  Reaktivierung fortgesetzt werden.
- Das optionale State-Feld kann von älteren Harness-Versionen ignoriert
  werden; ein Downgrade darf einen bereits dokumentierten Run jedoch nicht
  erneut nach `complete` überführen.
- Generierte Dateien werden bei einem Rollback nicht automatisch gelöscht.
  Eine Entfernung wäre eine separate, menschlich freizugebende Änderung.

## Nicht-Ziele

- LLM-basierte oder frei formulierte Run-Zusammenfassungen,
- eine neue Audit-Datenbank oder zentrale Credential-Infrastruktur,
- persönliche Tokens als Writer-Fallback,
- automatisches Umschreiben menschlicher Legacy-Prosa,
- Vermischen der Harness-Implementierung mit der privaten Immogent-Migration
  in demselben Pull Request,
- nachträgliches Umnummerieren bestehender RUN-001 bis RUN-008.
