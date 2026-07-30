# Pi Spec Harness

Ein **Pi-natives** Werkzeug für spezifikationsgetriebene Entwicklungsdurchläufe:
persistenter Run-State, schema-geprüfte Gates, und -- als zentrale
Design-Entscheidung -- **menschliche Entscheidungen laufen ausschließlich über
GitHub Issues**, nie nur im Chat.

## Verhältnis zu bestehenden Repositories

- [`munichdeveloper/spec-driven-agent-harness`](https://github.com/munichdeveloper/spec-driven-agent-harness)
  ist die **Vorlage/Referenz** für den Workflow-Gedanken (Run-State, Gates,
  Iterationsgrenzen). Dieses Repository wird bewusst **nicht** angefasst oder
  weiterentwickelt.
- [`munichdeveloper/Immogent`](https://github.com/munichdeveloper/Immogent)
  ist das **Referenzprodukt**, an dem der hier gebaute Harness in der Praxis
  erprobt wird.
- Dieses Repository (`pi-spec-harness`) ist die neue, eigenständige
  Implementierung, gebaut auf [Pi](https://pi.dev) statt auf einem
  read-only-Orchestrator. Pi selbst führt sowohl die Buchhaltung (dieses
  Repo) als auch die eigentliche Implementierung im Zielrepo aus.

## Kernunterschied zum alten Harness

Der alte Harness war bewusst read-only und hat selbst keine Codeänderungen
vorgenommen. Dieser Harness geht einen Schritt weiter: Pi darf Branches, PRs,
Issues und Kommentare im Zielrepo aktiv anlegen (`src/github/gh.ts` kapselt
jede erlaubte Schreibaktion explizit und auditierbar). Die Kontrolle bleibt
trotzdem beim Menschen, weil jede Entscheidung, die Risiko birgt, zwingend
über ein **GitHub-Issue-Human-Gate** (`src/gates/human-gate.ts`) läuft, das
nur durch ein Label (`harness:gate-approved` / `harness:gate-rejected`)
aufgelöst werden kann -- niemals durch eine Chat-Aussage.

## Nutzung

```bash
npm install
npm run check   # typecheck + lint + test
```

CLI direkt (ohne Build, via tsx):

```bash
npm run harness -- init \
  --run-id immogent-slice-001 \
  --repository munichdeveloper/Immogent \
  --requirement REQ-001 \
  --spec SPEC-011

npm run harness -- status --repository munichdeveloper/Immogent --run-id immogent-slice-001

npm run harness -- gate-open \
  --repository munichdeveloper/Immogent --run-id immogent-slice-001 \
  --gate-id merge-approval --type human \
  --title "Merge PR #NN freigeben" \
  --question "Darf PR #NN gemerged werden?"

npm run harness -- resume --repository munichdeveloper/Immogent --run-id immogent-slice-001
```

Ohne `--state <path>` nutzt das CLI standardmäßig das GitHub-Issue-Backend:
ein einziges, persistentes Tracking-Issue `[Harness Run] <run-id>` pro Run,
in dessen Body der komplette Run-State liegt (siehe
[docs/human-gates.md](docs/human-gates.md)). Der Dateibackend (`--state
<path>`) bleibt für rein lokale Tests verfügbar.

Als Pi-Skill: dieses Repository via `pi install git:github.com/munichdeveloper/pi-spec-harness`
installieren (oder projektlokal `.agents/skills/pi-spec-harness/` verlinken).
Siehe [`skills/pi-spec-harness/SKILL.md`](skills/pi-spec-harness/SKILL.md) für
das vollständige Ablaufprotokoll.

Weitere Details: [docs/workflow.md](docs/workflow.md),
[docs/human-gates.md](docs/human-gates.md),
[docs/event-driven-workflow.md](docs/event-driven-workflow.md) (User-facing),
[docs/implementation-guide.md](docs/implementation-guide.md) (für KI-Agenten:
Fallstricke & Checklisten).

## Zwei-PR-Topologie (TAC-14)

Ab SPEC-003 unterscheidet der Harness zwei getrennte Pull Requests pro Run:

```
main ←──── Delivery-PR (#10) ←──── Impl-PR (#42, Coding Agent)
             (human-managed)          (automated, against delivery branch)
```

| Feld | Bedeutung |
|------|-----------|
| `deliveryPullRequest` / `deliveryHeadSha` | PR des Delivery-Branch gegen `main`; nur nach SHA-spezifischem Human-Gate gemerged |
| `implementationPullRequest` / `implementationHeadSha` | PR des Coding Agent gegen den Delivery-Branch; nach grüner CI und gelösten Reviews automatisch übernommen |

Beide werden getrennt und mit vollständigen HEAD-SHAs im `RunState` geführt.
Ändert sich eine HEAD-SHA, werden die zugehörigen Gate-Evidenzen automatisch
invalidiert (TAC-01/TAC-11).

Der **finale Merge des Delivery-PRs** nach `main` bleibt bei `risk: high`
menschlich freizugeben (SHA-spezifisches `merge`-Human-Gate). Keine autonome
Freigabe ohne dieses Gate.

CLI-Befehle für die Zwei-PR-Topologie:

```bash
# Delivery-PR binden
npm run harness -- delivery-pr-bind \
  --repository owner/repo --run-id run-001 \
  --pull-request 10 --head-sha <40-char-sha>

# Implementierungs-PR binden (mit Basis-Validierung)
npm run harness -- impl-pr-bind \
  --repository owner/repo --run-id run-001 \
  --pull-request 42 --head-sha <40-char-sha> \
  --expected-base fix/delivery-branch

# Spec-Freigabe auf dem Delivery-Branch committen
npm run harness -- spec-approve \
  --repository owner/repo --run-id run-001

# Issue nach Erstellung aus GitHub re-lesen und verifizieren
npm run harness -- issue-verify \
  --repository owner/repo --run-id run-001 \
  --expected-labels harness:implementation status:ready ai:allowed \
  --expected-assignee copilot

# Coding Agent zuweisen (offizielle API, baseRef = Delivery-Branch)
npm run harness -- agent-assign \
  --repository owner/repo --run-id run-001

# Implementierungs-PR nach CI+Review in den Delivery-Branch mergen
npm run harness -- impl-pr-merge \
  --repository owner/repo --run-id run-001

# Orchestrator: gate-freie Phasen automatisch voranschreiten
npm run harness -- orchestrate \
  --repository owner/repo --run-id run-001
```

## Lokale Entwicklung

Voraussetzungen: Node.js 20.9+, `gh` CLI mit bestehender Anmeldung und
Schreibrechten (`repo`-Scope) auf die Zielrepositories.

```bash
npm install
npm run check
```
