# Konzeptskizze: Reaktive Workflows als installierbare Vorlagen

> Status: informelle Skizze, keine Spec. Dient dazu, das Zielbild zu schärfen,
> bevor daraus ein Requirement/eine Spec wird. Entstanden aus der
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
   Default `v0.1.0`).
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

## Übertragung auf die fehlenden reaktiven Flows

### 1. Spec → Issue

Heute: Immogent `spec-to-issue.yml`, Job `auto-create-issue`, mit
`scripts/create_issue_from_spec.py` als Immogent-lokalem Python-Skript.

Zielbild: Eine dünne Referenzdatei (`harness-spec-to-issue.yml`), Trigger
`push` auf `docs/**/*.md` mit Pfadfilter, die einen reusable Workflow im
Harness aufruft. Die Titel-/Body-Generierung aus der Spec-Frontmatter ist
bereits generisch (Spec-ID, Requirements-Liste, "Zerlegung in Issues"
-Abschnitt) und ließe sich als Harness-Funktion statt als
Immogent-Python-Skript pflegen. Der Zielrepo-Pfad zu den Specs
(`docs/30-specifications/`) müsste als Parameter in die Referenzdatei
wandern, weil er projektspezifisch ist.

### 2. Label-Bündelung (Freigabe-Gate)

Heute: Immogent `harness-approve-for-agent.yml`, bündelt
`harness:approved-for-agent` zu `status:ready` + `ai:allowed` +
`harness:implementation`.

Zielbild: Diese Logik ist bereits nahezu 1:1 das, was
`harness-gate-trigger.yml` für das Tracking-Issue tut (Label liest, Zustand
setzt) -- nur auf das Implementierungs-Issue statt das Tracking-Issue
bezogen. Vermutlich der einfachste der drei Flows, um zu generalisieren.

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

## Vorschlag für den Installationsbefehl

Statt drei separater `--install-*-workflow`-Flags (wie aktuell nur für Bugs)
läge ein generalisierter Ansatz näher:

```
harness init --install-workflows spec-to-issue,label-approval,process-audit \
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

Die heute als Übergangslösung eingebaute breite Spec-ID-Suche im
Idempotenz-Check (`spec-to-issue.yml`) wird dann überflüssig, weil es nur
noch eine Quelle für diesen Schritt gibt statt zwei koexistierender
Systeme.

## Bewusst offen gelassen

- Versionierungs-/Update-Strategie über den Bug-Workflow hinaus (wer stößt
  `update-managed` an, wie wird ein neuer Ref ausgerollt).
- Migrationsreihenfolge/-plan für Immogent (welcher Flow zuerst).
- Ob ein `harness reconcile`-Äquivalent (wie für Gates bereits vorhanden)
  auch für Spec→Issue und Label-Bündelung nötig ist.
- Ob `create_issue_from_spec.py` 1:1 nach TypeScript im Harness portiert
  wird oder der reusable Workflow weiterhin ein Python-Skript aufruft.

Diese Punkte gehören in ein formales Requirement/eine Spec, sobald die
Richtung bestätigt ist.
