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

npm run harness -- status --state artifacts/harness/immogent-slice-001.json

npm run harness -- gate-open \
  --state artifacts/harness/immogent-slice-001.json \
  --gate-id merge-approval --type human \
  --title "Merge PR #NN freigeben" \
  --question "Darf PR #NN gemerged werden?"

npm run harness -- resume --state artifacts/harness/immogent-slice-001.json
```

Als Pi-Skill: dieses Repository via `pi install git:github.com/munichdeveloper/pi-spec-harness`
installieren (oder projektlokal `.agents/skills/pi-spec-harness/` verlinken).
Siehe [`skills/pi-spec-harness/SKILL.md`](skills/pi-spec-harness/SKILL.md) für
das vollständige Ablaufprotokoll.

Weitere Details: [docs/workflow.md](docs/workflow.md),
[docs/human-gates.md](docs/human-gates.md).

## Lokale Entwicklung

Voraussetzungen: Node.js 20.9+, `gh` CLI mit bestehender Anmeldung und
Schreibrechten (`repo`-Scope) auf die Zielrepositories.

```bash
npm install
npm run check
```
