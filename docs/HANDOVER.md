# Pi Spec Harness – Handover

## Zweck

Der Harness steuert einen nachvollziehbaren Slice:

```text
Requirement → Spec → Issue → Implementation → Verification
→ höchstens drei Iterationen → Dokumentation → Merge → Complete
```

Der kanonische Zustand liegt in genau einem persistenten GitHub-Issue pro
Run. Chatverläufe, lokale Dateien und „neueste Ressource“-Suchen sind keine
Quelle der Wahrheit.

## Repositories

- `munichdeveloper/pi-spec-harness`: State Machine, CLI, Skill und
  Referenz-Action für Gate-Labels.
- Zielrepository, derzeit `munichdeveloper/Immogent`: Produktcode und
  produktspezifische Orchestrierungs-Actions.

## Wichtigste Dateien

### Harness

- `src/state/state-machine.ts`: Phasen, Gates, PR-/SHA-Bindung und
  Iterationslimit.
- `src/state/issue-store.ts`: persistenter State im Tracking-Issue.
- `src/cli.ts`: auditierbare Befehle.
- `src/workflows/template-catalog.ts`: installierbare Workflow-Vorlagen.
- `src/spec/issue-from-spec.ts`: gemeinsame Spec-zu-Issue-Abbildung.
- `src/agents-context/managed-block.ts`: verwalteter Harness-Kontext in
  Zielrepository-`AGENTS.md`-Dateien.
- `skills/pi-spec-harness/SKILL.md`: verpflichtendes Agentenprotokoll.
- `docs/event-driven-workflow.md`: sichere Ereigniskette.
- `.github/workflows/harness-gate-trigger.yml`: Self-Hosting-Gate-Trigger.

### Zielrepository (installierte Referenzen)

- `.github/workflows/harness-gate-trigger.yml`
- `.github/workflows/harness-spec-to-issue.yml`
- `.github/workflows/harness-label-approval-bundling.yml`
- optional `.github/workflows/harness-bug-triage.yml`

Weitere produkt- oder agentenspezifische Workflows können hinzukommen. Die
installierten Harness-Dateien bleiben dünne, markierte Referenzen auf zentral
versionierte reusable Workflows und dürfen nicht handschriftlich dupliziert
werden.

Ein eigener Cherry-Pick-nach-main-Workflow ist ausdrücklich unzulässig.

## State- und Labelvertrag

### Tracking-Issue

- Titel: `[Harness Run] <run-id>`
- Label: `harness:run`
- enthält den kanonischen JSON-State
- bleibt bis Phase `complete` offen

### Implementierungs-Issue

- Label: `harness:implementation`
- enthält Run-ID, Tracking-Issue und Spec
- darf zusätzlich `ai:allowed` und `status:ready` tragen
- trägt niemals `harness:run`

### Human-Gate

- offen: `harness:gate-open` + `status:needs-human`
- freigeben: `harness:gate-approved`
- ablehnen: `harness:gate-rejected`
- Kommentare zählen nicht als formale Entscheidung

## CLI

```bash
npm run harness -- init \
  --repository owner/repo \
  --run-id run-id \
  --requirement REQ-001 \
  --spec SPEC-001

npm run harness -- status \
  --repository owner/repo \
  --run-id run-id

npm run harness -- resume \
  --repository owner/repo \
  --run-id run-id

npm run harness -- advance \
  --repository owner/repo \
  --run-id run-id

npm run harness -- pr-bind \
  --repository owner/repo \
  --run-id run-id \
  --pull-request 42 \
  --head-sha <40-character-sha>

npm run harness -- init \
  --repository owner/repo \
  --run-id bootstrap-001 \
  --requirement REQ-001 \
  --spec SPEC-001 \
  --install-workflows spec-to-issue,label-approval-bundling \
  --workflow-ref <release-tag-or-full-sha> \
  --install-agents-context
```

`advance` erlaubt genau einen monotonen Schritt. Pending,
`needs-human` und `failed` Gates blockieren.

## Automationsvertrag

1. Gate-Trigger verarbeitet ausschließlich das gelabelte Tracking-Issue.
2. Issue-Erstellung erhält Run-ID und Tracking-Issue als explizite Inputs.
3. Spec-Dateien werden nur über die Spec-ID im State aufgelöst und müssen
   eindeutig sein.
4. Der PR verlinkt das Implementierungs-Issue; dieses verweist zurück auf den
   Run.
5. Verification benötigt nicht-draft PR, gebundenen Head-SHA, grüne
   abgeschlossene Checks und keine offenen Review-Threads.
6. Merge verwendet ausschließlich PR und SHA aus dem Run-State und ein
   SHA-spezifisches Human-Gate.
7. Ein bestandenes Merge-Gate schaltet noch nicht nach `complete`; erst der
   nachgewiesene Merge-Effekt schließt den Run ab.
8. Fehler sichern den Head unter `recovery/*`, buchen eine Iteration und
   schreiben niemals nach `main`.
9. Nach drei Fehlern wird gestoppt und eskaliert.

## Start eines neuen SaaS-Repositories

1. Einen unveränderlichen Harness-Release-Tag oder vollständigen SHA wählen.
2. Harness-CLI und Skill verfügbar machen.
3. Labels für Run, Implementation und Gates anlegen.
4. `spec-to-issue` und `label-approval-bundling` über
   `--install-workflows` installieren; optional `bug-triage` ergänzen.
5. Den verwalteten `AGENTS.md`-Block über `--install-agents-context`
   installieren und produktspezifischen Kontext außerhalb der Marker belassen.
6. `COPILOT_ASSIGN_PAT` nur dann als eng begrenztes Secret hinterlegen, wenn
   GitHub Copilot Issues automatisch übernehmen soll.
7. Branch Protection und erforderliche CI-Checks konfigurieren.
8. Einen synthetischen Smoke-Run durchführen:
   freigegebene Spec → Issue → Freigabelabel → deterministischer Run →
   Delivery-PR → Implementation-PR → Verification/Recovery → Merge-Gate →
   nachgewiesener Merge-Effekt.

Bestehende Zielrepositories werden nicht automatisch migriert. Lokale
Äquivalente werden erst in einem bewussten, separat geprüften Change durch
die installierten Referenzen ersetzt.

## Sicherheitsprüfung vor Aktivierung

- keine Suche nach „latest“, `tail -1`, `sort -V` oder `--limit 1`,
- kein `git push origin main`,
- keine echten Nutzer- oder Produktionsdaten in State/Evidence,
- genau ein Tracking-Issue pro Run,
- PR und SHA im State gebunden,
- Workflow-Syntax und Vertragstests grün,
- Human-Gate für Medium-/High-Risk-Merge.

## Bekannte Betriebsanforderungen

- GitHub Actions muss Issue-, PR- und je nach Workflow
  `contents:write`-Berechtigungen besitzen.
- Jeder Zielrepository-Workflow mit `gh pr checks` benötigt zusätzlich
  `checks: read` und `statuses: read`; nicht deklarierte Berechtigungen sind
  bei einem expliziten `permissions`-Block nicht implizit verfügbar.
- Merge-Reconciliation verwendet ausschließlich das persistente
  Tracking-Issue und das bereits bestandene SHA-spezifische Gate. Sie wählt
  niemals den neuesten PR oder SHA.
- Recovery benötigt `contents:write`, aber nur zum Erzeugen des
  `recovery/*`-Refs.
- Der Harness-Stand mit `advance` und `pr-bind` muss im Default-Branch
  verfügbar sein, bevor Zielrepository-Actions diese Befehle verwenden.
- Abhängigkeitswarnungen werden separat bewertet; niemals automatisch
  `npm audit fix --force` ausführen.
