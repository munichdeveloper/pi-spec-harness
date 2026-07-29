# Human Gates: ein persistentes GitHub Issue pro Run als einzige Entscheidungsschicht

## Motivation

Bei rein chat-basierter Arbeit verschwimmen Entscheidungen im Gesprächsfluss:
es ist im Nachhinein schwer erkennbar, wann genau eine Freigabe erteilt wurde
und wofür genau. Dieses Repository erzwingt stattdessen: **jede
Entscheidung, die einen Menschen braucht, läuft über das eine persistente
GitHub-Issue des Runs** im Zielrepository, mit eindeutigem
Auflösungsmechanismus.

Der komplette Run-State (Phasen, Gates, Iterationen) lebt dabei direkt im
Issue-Body (kanonisches JSON in einem klar markierten Block, siehe
`src/state/issue-store.ts`). Es gibt keine separate Datei, die nur lokal bei
einem Menschen oder einer KI-Instanz existiert -- jede GitHub Action mit
Lesezugriff auf das Issue sieht denselben Stand.

## Protokoll

1. `harness init --repository <repo> --run-id <id> ...` legt (idempotent) ein
   **Tracking-Issue** an: Titel `[Harness Run] <run-id>`, Label
   `harness:run`, Body = vollständiger Run-State.
2. Pi erkennt Entscheidungsbedarf (Produktentscheidung, Kosten, Secrets,
   Risiko, Merge bei `risk >= medium`, Eskalation nach 3 Iterationen,
   Unklarheit im Requirement/Spec/Issue).
3. Pi registriert ein Gate vom Typ `human` und ruft `gate-open --type human`
   auf. Es wird **kein neues Issue erzeugt** -- stattdessen:
   - Labels `status:needs-human` + `harness:gate-open` werden auf das
     bestehende Tracking-Issue gesetzt.
   - Ein Kommentar mit Frage und Kontext wird angehängt (Entscheidungsjournal).
   - Der Issue-Body wird mit dem aktualisierten Run-State überschrieben.
4. Pi verweist im Chat kurz auf das Issue und pausiert die Arbeit an diesem
   Run.
5. Ein Mensch beantwortet die Frage **ausschließlich** durch Setzen von:
   - `harness:gate-approved` → Freigabe, oder
   - `harness:gate-rejected` → Ablehnung.
   Kommentare sind für Kontext willkommen, zählen aber nicht als Entscheidung.
6. `harness resume` (manuell, durch Pi, oder durch eine GitHub Action, siehe
   unten) pollt das Issue, übernimmt die Entscheidung in den Run-State
   (`applyGateDecision`), kommentiert das Ergebnis und **entfernt die
   transienten Labels** (`harness:gate-open`, `status:needs-human`,
   `harness:gate-approved`/`-rejected`). Das Issue bleibt offen -- es wird
   nur geschlossen, wenn der gesamte Run `complete` erreicht.
   Der Befehl `harness advance` darf anschließend genau eine Phase
   weiterschalten, sofern `computeNextAction` das erlaubt. Er überspringt
   weder ein Human- noch ein technisches Gate.
7. Beim nächsten Human-Gate desselben Runs wiederholt sich Schritt 3 auf
   **demselben** Issue. Ein Run erzeugt über seine gesamte Lebensdauer also
   genau ein Issue, nicht eines pro Gate.

## Event-getrieben statt Chat-Polling

Weil Zustand und Entscheidung vollständig im Issue leben, kann eine GitHub
Action im Zielrepository (getriggert auf `issues: [labeled]`, gefiltert auf
`harness:gate-approved`/`-rejected`) `harness resume --repository <repo>
--run-id <id>` und danach gegebenenfalls `harness advance` aufrufen, ohne
dass eine Chat-Sitzung offen sein muss. Das Harness-Repository enthält dafür
selbst `.github/workflows/harness-gate-trigger.yml`. Zielrepositories sollen
denselben engen Vertrag übernehmen: ausschließlich das gerade gelabelte
Tracking-Issue auswerten, niemals den „neuesten“ Run suchen und pro
Label-Ereignis höchstens eine Phase weiterschalten.

## Warum Labels statt Kommentartext?

Labels sind eindeutig, maschinenlesbar und lassen sich nicht versehentlich
als Freigabe fehlinterpretieren (anders als ein Kommentar wie "sieht gut
aus"). Das entspricht der alten Harness-Regel, dass ein Merge-Gate niemals
ein offenes Human-Gate stillschweigend überspringen darf -- hier technisch
erzwungen, nicht nur dokumentiert.

## Beispiel

```bash
npm run harness -- gate-open \
  --repository munichdeveloper/Immogent \
  --run-id immogent-slice-001 \
  --gate-id merge-approval \
  --type human \
  --title "Merge PR #42 freigeben" \
  --question "PR #42 implementiert SPEC-011 (Kaufprofil-Wizard, risk: medium). CI grün, keine offenen Review-Threads. Freigabe zum Merge?" \
  --context "PR: https://github.com/munichdeveloper/Immogent/pull/42" \
  --context "Spec: docs/30-specifications/SPEC-011-authentifizierte-kaufprofil-erstellung.md"
```

Das legt (find-or-create) das Tracking-Issue `[Harness Run] immogent-slice-001`
an bzw. verwendet es weiter und hängt Frage/Kontext als Kommentar an.

Ergebnis: Das bereits vorhandene Tracking-Issue des Runs zeigt genau diese
Frage und bleibt bis zum Abschluss des gesamten Runs offen.
