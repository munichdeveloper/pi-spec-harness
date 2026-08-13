# Reaktive Workflows als installierbare Vorlagen

> Status: historisches Konzept und Entscheidungsherkunft. Der generische
> Katalog, Spec→Issue, Label-Bündelung und der verwaltete `AGENTS.md`-Kontext
> sind inzwischen durch REQ/SPEC-006 bis -008 spezifiziert und implementiert.
> Verbindlich sind diese Specs sowie `docs/workflow.md`. Entstanden aus der
> Beobachtung, dass Immogent eigene, handgeschriebene GitHub-Actions-Workflows
> (`spec-to-issue.yml`, `harness-approve-for-agent.yml`,
> `process-audit-automation.yml`) besitzt, die denselben reaktiven Anspruch
> verfolgen, den der Harness laut `docs/event-driven-workflow.md` ohnehin
> schon hat -- nur eben lokal in Immogent nachgebaut statt aus dem Harness
> installiert.

## Ausgangsbeobachtung

Der Harness sollte laut ursprünglichem Anspruch "headless" laufen: Ereignisse
im Zielrepo (Spec approved, Issue gelabelt, PR gemergt, ...) lösen ohne
offene Chat-Sitzung automatisch den nächsten Schritt aus. Das ist für die
Gate-/Resume-/Merge-Kette bereits gebaut (`event-driven-workflow.md`,
`.github/workflows/harness-gate-trigger.yml`). Für zwei weitere Schritte --
Spec → Issue und die Bündelung der Freigabe-Label -- wurde dieses Muster
nicht aus dem Harness installiert, sondern in Immogent unabhängig
nachgebaut. Damit entstanden zwei parallele Implementierungen derselben
Idee statt einer.

## Bereits vorhandenes Lösungsmuster: der Bug-Workflow

Für den Bug-zu-PR-Track (SPEC-003/SPEC-004) existiert das Zielmuster schon
vollständig, siehe `src/bug/workflow-reference.ts` und
`harness init --install-bug-workflow`:

1. **Dünne Referenzdatei im Zielrepo.** `harness init --install-bug-workflow`
   schreibt `.github/workflows/harness-bug-triage.yml` in das Zielrepo. Diese
   Datei ist bewusst minimal: Sie definiert nur den Trigger
   (`issues: opened, typed, labeled`) und ruft per `uses:` einen
   **reusable workflow** im Harness-Repo auf.
2. **Zentrale Logik als reusable workflow.** Die eigentliche Implementierung
   lebt in `pi-spec-harness/.github/workflows/bug-triage.yml` und wird über
   `uses: munichdeveloper/pi-spec-harness/.github/workflows/bug-triage.yml@<ref>`
   eingebunden -- versioniert über einen Tag/SHA (`--bug-workflow-ref`,
   Default `v0.2.1`).
3. **Managed-Marker für Drift-Erkennung.** Jede installierte Datei beginnt
   mit `# Managed by pi-spec-harness: bug-workflow-reference v1`.
   `decideBugWorkflowInstall()` unterscheidet `create` / `noop` /
   `update-managed` / `conflict` -- eine von Hand geänderte Datei wird nicht
   stillschweigend überschrieben.

Dieses Muster löst genau das Problem, das die Repo-Lokalität von
`workflow_run`/`deployment_status`/`check_run` aufwirft: Der **Trigger**
bleibt zwangsläufig im Zielrepo (GitHub liefert diese Events nicht
repo-übergreifend), aber die **Logik** dahinter ist zentral im Harness
gepflegt und wird nur referenziert, nicht dupliziert.

## Umgesetzte reaktive Flows

### 1. Spec → Issue

Umgesetzt ist eine dünne Referenzdatei (`harness-spec-to-issue.yml`), Trigger
`push` auf `docs/**/*.md` mit Pfadfilter, die einen reusable Workflow im
Harness aufruft. Die Titel-/Body-Generierung aus der Spec-Frontmatter ist
generisch in `src/spec/issue-from-spec.ts` umgesetzt. Der Zielrepo-Pfad zu
den Specs wird als projektspezifischer Parameter übergeben.

### 2. Label-Bündelung (Freigabe-Gate)

Die Vorlage `label-approval-bundling` bündelt
`harness:approved-for-agent` zu `status:ready` + `ai:allowed` +
`harness:implementation` und bootstrapped den deterministischen Run
`issue-<issue-number>` idempotent.

### 3. Prozess-Audit-Observer

Heute: Immogent `process-audit-automation.yml`, beobachtet
`workflow_run`/`pull_request_target` für tatsächlich Harness-getriebene
Workflow-Namen (siehe RUN-008-Bereinigung von heute).

Besonderheit: Dieser Flow **muss** technisch bedingt eine Datei im Zielrepo
bleiben (Trigger-Events sind repo-lokal) -- das ist kein Gegenargument gegen
das Vorlagen-Muster, sondern genau der Fall, für den es gebaut ist. Die
Payload-Konstruktion (welche Felder aus welchem Event-Typ extrahiert werden)
ist generisch und könnte als reusable Workflow zentralisiert werden; nur die
Liste der zu beobachtenden Workflow-Namen bleibt zwangsläufig
projektspezifisch und gehört in die Referenzdatei-Parameter.

## Installationsbefehl

Statt drei separater `--install-*-workflow`-Flags (wie aktuell nur für Bugs)
läge ein generalisierter Ansatz näher:

```
harness init --install-workflows spec-to-issue,label-approval-bundling \
  --workflow-ref <tag/sha> ...
```

mit demselben Managed-Marker-Mechanismus wie beim Bug-Workflow, je Flow eine
eigene Referenzdatei und ein eigener reusable Workflow im Harness-Repo.

## Konsequenz für die heutigen Immogent-Änderungen

Wenn dieses Muster umgesetzt wird, werden folgende, heute in Immogent
handgebauten Artefakte durch installierte Referenzdateien ersetzt:

- `.github/workflows/spec-to-issue.yml` (Job `auto-create-issue`)
- `.github/workflows/harness-approve-for-agent.yml`
- `scripts/create_issue_from_spec.py` (Logik wandert in den Harness)

Bis zu einer bewussten Migration koexistieren lokale Zielrepo-Automationen
und die installierbaren Vorlagen. Die breite Spec-ID-Suche verhindert dabei
Duplikate über beide Einstiegspfade hinweg.

## Bewusst offen gelassen

- Release- und Rollout-Strategie für neue gepinnte Workflow-Refs.
- Migrationsreihenfolge/-plan für Immogent (welcher Flow zuerst).
- Ob ein `harness reconcile`-Äquivalent (wie für Gates bereits vorhanden)
  auch für Spec→Issue und Label-Bündelung nötig ist.
- Eine installierbare Vorlage für den Prozess-Audit-Observer; dessen Scope
  bleibt gemäß REQ/SPEC-005 auf Harness-ausgelöste Wirkungen begrenzt.

Diese Punkte benötigen bei Umsetzung jeweils ein formales Requirement und
eine freigegebene Spec.
