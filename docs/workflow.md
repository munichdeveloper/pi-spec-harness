# Workflow

Angelehnt an den im alten Harness-Repo dokumentierten Ablauf, aber mit Pi als
aktivem Implementierungsagenten statt eines externen Codex-Prozesses.

```
Requirement Spec --(Produktfreigabe: Human Gate)--> Software Spec
Software Spec --(technische Freigabe: Human Gate bei risk >= medium)--> GitHub Issue
GitHub Issue --> Pi-Implementierung (Branch, Code, Tests, Doku)
Pi-Implementierung --> Verifikation (CI, Acceptance, Review)
Verifikation --failed--> Iteration (max. 3x) --> Verifikation
Verifikation --failed nach 3x--> Human Gate (Eskalation)
Verifikation --passed--> Dokumentation
Dokumentation --> Merge (Human Gate bei risk >= medium, sonst automatisch)
Merge --> Run als 'complete' markieren
```

## Phasen (`PhaseId`)

| Phase | Bedeutung |
|---|---|
| `requirement` | Requirement Spec liegt vor und ist geprüft |
| `spec` | Software Spec liegt vor und ist geprüft |
| `issue` | GitHub Issue existiert mit passenden Labels |
| `implementation` | Branch/Code/Tests werden erstellt |
| `verification` | CI, Acceptance, Review laufen |
| `iteration` | Korrekturschleifen bei Fehlschlag |
| `documentation` | Doku wird im selben PR aktualisiert |
| `merge` | PR wird gemerged |
| `complete` | Run abgeschlossen |

## Gates (`GateType`)

| Typ | Wer löst auf | Beispiel |
|---|---|---|
| `spec` | Pi, nach Prüfung des Frontmatter-Status | Spec ist `approved` |
| `issue` | Pi, nach Prüfung der Labels | Issue hat `status:ready` + `ai:allowed` |
| `runtime` | Pi, nach Ausführung/Smoke-Test | externer Dienst reagiert wie erwartet |
| `review` | Pi, nach Prüfung offener Review-Threads | keine offenen Threads mehr |
| `merge` | Mensch bei `risk >= medium`, sonst Pi | siehe `docs/human-gates.md` |
| `human` | **immer** ein Mensch, über GitHub Issue | Produktentscheidung, Kosten, Risiko |

Iterationsgrenze: `maxAutomaticIterations` (Default 3). Danach zwingt
`computeNextAction` eine Eskalation als `human`-Gate.

## Zustandsregeln

- `advance` schaltet höchstens eine Phase weiter.
- Phasen dürfen weder übersprungen noch rückwärts gesetzt werden.
- Nicht-menschliche Gates mit `pending`, `needs-human` oder `failed`
  blockieren genauso wie offene Human-Gates.
- Ein PR wird mit Nummer und vollständigem Head-SHA an den Run gebunden.
- Ein neuer SHA desselben PR setzt bestehende Review-Evidence zurück.
- Ein anderer PR kann nicht stillschweigend an denselben Run gebunden werden.

## Bug-Track (SPEC-004)

Neben dem Feature-Run gibt es einen separaten, schlanken Bug-Track:

1. Ein Zielrepository installiert eine dünne Referenzdatei
   `.github/workflows/harness-bug-triage.yml` (über `harness init --install-bug-workflow`).
2. Diese Datei triggert auf die für Bugs relevanten `issues`-Ereignisse
   (`opened`, `typed` sowie das Hinzufügen von `type:bug`) und ruft
   den zentral gepflegten reusable Workflow
   `munichdeveloper/pi-spec-harness/.github/workflows/bug-triage.yml@<pinned-ref>`
   auf.
3. `opened` deckt insbesondere Bug-Issue-Templates ab, deren initiales Label
   kein separates `labeled`-Event erzeugt. Der Trigger filtert serverseitig
   auf das konkrete auslösende Ereignis und
   serialisiert Läufe pro Repository und Issue. Andere gleichzeitig gesetzte
   Labels starten keine weitere Pipeline.
4. Der reusable Workflow erzwingt eine gepinnte
   `claude-code-action`-Version `>= v1.0.94`, setzt Idempotenz-Labels
   (`bug-pipeline:started` / `bug-pipeline:in-progress` /
   `bug-pipeline:completed`) und kommentiert das Issue vor jedem PR-Pfad. Der
   dauerhafte `started`-Marker schützt auch nach einem Lauf ohne PR gegen
   verspätete oder doppelt zugestellte Events; ein bewusster Neustart entfernt
   diesen Marker explizit.
5. Ohne eindeutige Reproduktion/Verifikation wird kein PR erstellt; stattdessen
   wird `status:needs-human` gesetzt.
6. Bei erfolgreichem PR werden Issue-Autor oder konfigurierter Owner als
   Reviewer/Assignee eingetragen.

Ein PR zählt nur dann als Ergebnis des Bug-Laufs, wenn GitHub ihn über eine
Closing-Referenz (beispielsweise `Fixes #82`) exakt mit dem auslösenden Issue
verknüpft. Eine bloße Erwähnung wie `Issue #82` reicht nicht aus; dadurch kann
ein unabhängiger Infrastruktur-PR nicht versehentlich den Bug-Lauf abschließen.

Der Bug-Track ersetzt nicht den bestehenden Feature-Run und fügt keinen neuen
Auto-Merge-Pfad hinzu. CI, Review-Threads und Merge-/Human-Gates bleiben
unverändert zuständig.

## Generischer Workflow-Vorlagen-Katalog (SPEC-006)

`harness init --install-bug-workflow` war ursprünglich fest auf den
Bug-Track verdrahtet. Seit SPEC-006 ist das der erste Eintrag eines
generischen Katalogs, `WORKFLOW_TEMPLATE_CATALOG`
(`src/workflows/template-catalog.ts`): jeder Eintrag beschreibt Zielpfad,
Managed-Marker, Pfad des reusable Workflows im Harness-Repo und einen
Default-Ref. Neue reaktive Fähigkeiten werden als zusätzlicher
Katalogeintrag ergänzt, ohne den Installationsmechanismus selbst zu
ändern.

Verfügbare Vorlagennamen (für `--install-workflows <name>[,<name>...]`):

| Name | Referenzdatei im Zielrepo | Reusable Workflow (Harness-Repo) |
|---|---|---|
| `bug-triage` | `.github/workflows/harness-bug-triage.yml` | `.github/workflows/bug-triage.yml` |
| `spec-to-issue` | `.github/workflows/harness-spec-to-issue.yml` | `.github/workflows/spec-to-issue.yml` |
| `label-approval-bundling` | `.github/workflows/harness-label-approval-bundling.yml` | `.github/workflows/label-approval-bundling.yml` |

```bash
npm run harness -- init \
  --run-id run-001 \
  --repository owner/repo \
  --requirement REQ-006 \
  --spec SPEC-006 \
  --install-workflows bug-triage,spec-to-issue,label-approval-bundling \
  --workflow-ref v0.2.2
```

`--install-bug-workflow` bleibt unverändert nutzbar und erzeugt
byteidentische Referenzdateien wie zuvor; beide Flags lassen sich
kombinieren, ohne dass `bug-triage` doppelt geschrieben wird. Jede
Installation erkennt `create` / `noop` / `update-managed` / `conflict`; ein
`conflict` schreibt keine Datei und wird im CLI-Ergebnis unter
`result.conflicts[]` sichtbar gemacht.

## Reaktive Spec-zu-Issue-Pipeline und Freigabe-Label-Bündelung (SPEC-007)

Zusätzlich zum bestehenden CLI-gesteuerten Pfad (`harness issue-create`,
optional mit `--from-spec-path <pfad>`, das intern dieselbe
`buildIssueFromSpec()`-Logik aus `src/spec/issue-from-spec.ts` verwendet)
gibt es einen rein reaktiven Einstiegspunkt ganz ohne vorherigen `harness
init`-Aufruf:

1. `spec-to-issue` (Vorlage): triggert auf `push`, der eine Spec unter dem
   konfigurierten `spec-path-glob` ändert. Nur für `status: approved`
   erzeugt die Pipeline über `harness spec-to-issue --repository <repo>
   --spec-path <pfad>` genau ein Issue; vorher wird breit nach der Spec-ID
   im Titel gesucht (`in:title`), damit sowohl ein über diese Pipeline als
   auch ein über `harness issue-create` erzeugtes Issue erkannt wird.
2. `label-approval-bundling` (Vorlage): triggert auf `issues.labeled` mit
   einem konfigurierbaren `trigger-label` (Default
   `harness:approved-for-agent`) und setzt die `target-labels` (Default
   `status:ready`, `ai:allowed`, `harness:implementation`) in einer
   einzigen Aktion. Im selben Lauf ruft sie anschließend `harness init`
   non-interaktiv mit einer deterministisch aus der Implementierungs-Issue-
   Nummer abgeleiteten Run-ID (`issue-<number>`) auf und bootstrapped so,
   ohne Chat-Sitzung, das kanonische Tracking-Issue für diesen Run. Ein
   bereits bestehender Run für dieselbe Run-ID (manuell oder automatisch
   angelegt) wird unverändert weiterverwendet -- es entsteht kein zweites
   Tracking-Issue.

Referenzprojekte mit heute lokal gepflegten Äquivalenten (z. B. Immogents
`spec-to-issue.yml` / `harness-approve-for-agent.yml` /
`scripts/create_issue_from_spec.py`) werden durch die Einführung dieser
Vorlagen nicht automatisch migriert; die Umstellung auf
`--install-workflows spec-to-issue,label-approval-bundling` bleibt ein
bewusster, separater Schritt pro Repository.

## Verwalteter Kontextblock in AGENTS.md (SPEC-008)

`harness init --install-agents-context` fügt einen durch
`<!-- BEGIN pi-spec-harness managed context v1 -->` /
`<!-- END pi-spec-harness managed context v1 -->` abgegrenzten Block in die
`AGENTS.md` des Zielrepositories ein bzw. aktualisiert ihn
(`src/agents-context/managed-block.ts`). Fehlt die Datei, wird sie
ausschließlich mit diesem Block angelegt; existiert bereits eigener,
produktspezifischer Inhalt ohne Marker, wird der Block ergänzt, ohne
etwas zu verändern oder zu löschen. Die Option ist unabhängig von
`--install-workflows`/`--install-bug-workflow` und mit ihnen kombinierbar.

## Fingerprint-gebundener Capability-Smoke (SPEC-010)

### Überblick

Bevor der produktive Bug-Agent startet, prüft der Bug-Lauf, ob unter der
aktuell wirksamen Credential- und Berechtigungskonfiguration tatsächlich
Bash-, Write- und Edit-Toolaufrufe gelingen. Das Ergebnis ist eine
kryptographisch gebundene Cache-Attestation. Ein Cache-Treffer (korrekter
Fingerprint, valides Manifest) überspringt den kostenpflichtigen Smoke-Lauf
vollständig; erst ein Cache-Miss löst genau einen Smoke aus.

### Fingerprint (TAC-01)

Ein deterministischer SHA-256-Fingerprint wird aus drei kanonischen Inputs
gebildet, die sowohl in der TypeScript-Funktion (`src/capability/fingerprint.ts`)
als auch im Workflow-Skript identisch implementiert sind:

- **Action-Ref** – der gepinnte `claude-code-action`-Ref (`vX.Y.Z` oder
  40-Zeichen-SHA)
- **`permissions.allow`** – das kanonisch sortierte, kompakt JSON-serialisierte
  Allow-Array, das an `claude-code-action` übergeben wird
- **Contract-Version** – eine konstante Zeichenkette (`CAPABILITY_CONTRACT_VERSION`
  in `src/capability/fingerprint.ts`); ein Bump invalidiert alle vorhandenen
  Attestationen

Freie Zusatzwerte (Issue-Inhalt, Branch-Name, Secrets, Run-IDs) sind
ausdrücklich **kein** Bestandteil des Fingerprints.

### Cache-Attestation (TAC-02/TAC-03)

Der Cache-Key lautet `harness-capability-attestation-<fingerprint>`. Der
Workflow verwendet **nur** einen exakten Key-Lookup; `restore-keys`-Präfixe
sind unzulässig (TAC-02). Das Cache-Manifest enthält:

```json
{
  "schemaVersion": "1",
  "fingerprint": "<sha256>",
  "contractVersion": "1",
  "capabilityContract": { "bash": true, "write": true, "edit": true, "fileContentVerified": true },
  "workflowRun": "<run-id>",
  "attestedAt": "<iso8601>"
}
```

Nur ein vollständig grüner deterministischer Verifier schreibt die finale
Attestation (TAC-03). Das Manifest wird vor jedem Cache-Treffer gegen den
berechneten Fingerprint und die Schema-Version validiert.

### Capability-Smoke-Ablauf

1. **Credential-Check** (TAC-11): Ist weder `ANTHROPIC_API_KEY` noch
   `CLAUDE_CODE_OAUTH_TOKEN` gesetzt, schlägt der Workflow mit einer klaren
   Meldung fehl, bevor `claude-code-action` aufgerufen wird.
2. **Fingerprint + Cache-Restore** (TAC-02/TAC-06): Cache-Treffer überspringt
   den Smoke.
3. **Smoke-Agent** (TAC-04): Der Agent erhält einen eng begrenzten Prompt mit
   einem zufälligen Einmal-Marker. Er muss einen Bash-Befehl ausführen, eine
   Datei schreiben und den Inhalt per Edit ersetzen.
4. **Deterministischer Verifier** (TAC-04/TAC-05): Tatsächliche erfolgreiche
   Toolaufrufe werden ausgewertet; Textausgaben des Agenten sind keine Evidence.
   Fehlt eine Fähigkeit, schlägt der Workflow rot ab.
5. **Attestation schreiben** (TAC-03): Nur nach vollständig grünem Verifier wird
   der Cache-Key geschrieben.
6. **Gate** (TAC-08): Bei Smoke-Fehler wird `status:needs-human` gesetzt, ein
   Kommentar mit der konkreten Fehlerursache hinzugefügt und der produktive
   Agent-Step übersprungen.

### Kostenverhalten und Attestation-Lebensdauer

- Ein Smoke verursacht einen echten `claude-code-action`-Lauf. Er findet nur
  bei Cache-Miss statt.
- GitHub-Actions-Caches laufen standardmäßig nach 7 Tagen ohne Zugriff ab.
  Abgelaufene oder gelöschte Attestationen führen bei der nächsten Ausführung
  zu einem automatischen neuen Smoke.
- Jede Änderung an Action-Ref oder `permissions.allow` erzeugt einen neuen
  Fingerprint und damit einen obligatorischen neuen Smoke.

### Manuelle Ausführung

```bash
gh workflow run harness-capability-smoke.yml --repo <owner>/<repo>
```

oder über das GitHub-UI: **Actions → Harness Capability Smoke → Run workflow**.

### Fehlerdiagnose

| Symptom | Ursache | Lösung |
|---|---|---|
| `Neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set` | Fehlende Credentials | Secret im Repository-Settings setzen |
| `Capability smoke failed. bash_ok=false` | Bash-Befehl wurde blockiert | `settings.permissions.allow` prüfen |
| `File content mismatch` | Edit-Tool hat Datei nicht korrekt geändert | Smoke wiederholen; ggf. Action-Pin prüfen |
| `Cached attestation fingerprint … does not match` | Cache-Poisoning oder falscher Key | Cache manuell löschen und Smoke neu auslösen |

### Installation (TAC-12)

```bash
harness init --install-workflows capability-smoke --harness-ref v0.2.2
```

Erstellt/aktualisiert `.github/workflows/harness-capability-smoke.yml`
idempotent; ein nicht verwalteter Konflikt wird als Fehler gemeldet.

### Sicherer Rollout

1. Harness-Release mit `capability-smoke.yml` veröffentlichen.
2. `harness init --install-workflows capability-smoke` im Zielrepository
   ausführen.
3. Manuellen Smoke per `workflow_dispatch` auslösen und auf grünen Run
   warten.
4. Anschließend Bug-Pipeline aktivieren.
5. Rollback: Caller auf vorherigen Harness-Ref zurücksetzen. Die
   Attestation mit dem neuen Fingerprint ist für die alte Konfiguration
   nicht gültig – ein erneuter Smoke ist automatisch notwendig.
