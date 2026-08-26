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
   - Das Gate wird zuerst mit `publication.status: prepared`, strukturiertem
     Entscheidungskontext und stabilem Kommentar-Marker im
     kanonischen State gespeichert.
   - Nach dem Bereinigen alter Decision-Labels werden `openedAt` und
     `publication.status: publishing` gespeichert. Erst danach wird das Gate
     extern sichtbar.
   - Labels `status:needs-human` + `harness:gate-open` werden auf das
     bestehende Tracking-Issue gesetzt.
   - Ein Kommentar mit Frage und Kontext wird idempotent angehängt
     (Entscheidungsjournal), danach wird `publication.status: open` gespeichert.
   Ein Abbruch zwischen diesen Schritten ist wiederaufnehmbar und erzeugt
   keinen zweiten Gate-Kommentar.
4. Pi verweist im Chat kurz auf das Issue und pausiert die Arbeit an diesem
   Run.
5. Ein Mensch beantwortet die Frage **ausschließlich** durch Setzen von:
   - `harness:gate-approved` → Freigabe, oder
   - `harness:gate-rejected` → Ablehnung.
   Kommentare sind für Kontext willkommen, zählen aber nicht als Entscheidung.
6. `harness resume` (manuell, durch Pi, oder durch eine GitHub Action, siehe
   unten) pollt das Issue, übernimmt die Entscheidung in den Run-State
   (`computeGateDecision`), speichert gleichzeitig `cleanupPending: true`,
   kommentiert danach das Ergebnis und **entfernt die
   transienten Labels** (`harness:gate-open`, `status:needs-human`,
   `harness:gate-approved`/`-rejected`). Erst nach erfolgreichem Cleanup wird
   `cleanupPending` gelöscht. `resume` und `reconcile` wiederholen einen
   unterbrochenen Cleanup idempotent. Das Issue bleibt offen -- es wird
   nur geschlossen, wenn der gesamte Run `complete` erreicht.
   Der Befehl `harness advance` darf anschließend genau eine Phase
   weiterschalten, sofern `computeNextAction` das erlaubt. Er überspringt
   weder ein Human- noch ein technisches Gate.
7. Beim nächsten Human-Gate desselben Runs wiederholt sich Schritt 3 auf
   **demselben** Issue. Ein Run erzeugt über seine gesamte Lebensdauer also
   genau ein Issue, nicht eines pro Gate.

## Nachweisbare False Positives superseden

Ein technisch oder operativ nachweisbares False Positive wird weder als
Freigabe noch als Ablehnung verbucht. Dafür existiert ausschließlich der
benannte Befehl `gate-supersede`. Er verlangt Gate-ID, Klassifikation,
Idempotenzschlüssel, Begründung, Beschreibung, kanonischen Akteur,
Zugriffsrolle und Evidence. Kommentartext oder das Entfernen von Labels kann
keine Supersession auslösen.

Die Ausführung ist loss-safe geordnet:

1. Das ursprüngliche Gate bleibt erhalten und erhält den terminalen Zustand
   `superseded`, den strukturierten Supersession-Datensatz sowie
   `cleanupPending: true`. Dieser State wird zuerst gespeichert.
2. Ein vollständiger SPEC-005-Envelope mit
   `process_code: PROCESS_RECONCILIATION` und `outcome: SUPERSEDED` wird an den
   Audit Recorder gesendet und auf dessen Default Branch bestätigt.
3. Erst nach der dauerhaften Audit-Bestätigung werden Kommentar und transiente
   Gate-Labels idempotent bereinigt. Danach wird `cleanupPending` gelöscht.

Wiederholungen mit demselben Idempotenzschlüssel setzen am gespeicherten
Checkpoint fort. Ein anderer Schlüssel wird abgelehnt. Approval-, Merge-,
Security-, Kosten-, Spec-, Migrations-, Deployment- und Production-Gates sind
explizit geschützt und können diesen Pfad nicht verwenden.

```bash
npm run harness -- gate-supersede \
  --repository munichdeveloper/pi-spec-harness \
  --run-id issue-70 \
  --gate-id agent-assign-unverified \
  --idempotency-key gate-supersede:issue-70:agent-assign-unverified:v1 \
  --classification automation-false-positive \
  --actor CODEX \
  --access-role CODEX_CHAT_SESSION \
  --reason "Obsolete delegation attempt conflicts with the corrected responsibility model" \
  --description "Preserve the false-positive gate and resume only after audit confirmation" \
  --evidence https://github.com/munichdeveloper/pi-spec-harness/issues/82
```

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
  --scope "Merge des verifizierten SPEC-011-Slices" \
  --criterion "Alle erforderlichen Checks sind grün" \
  --risk "Medium: Änderung am produktiven Suchprofilfluss" \
  --non-goal "Keine Datenmigration" \
  --follow-up-action "SHA-spezifisch nach main mergen" \
  --context "PR: https://github.com/munichdeveloper/Immogent/pull/42" \
  --context "Spec: docs/30-specifications/SPEC-011-authentifizierte-kaufprofil-erstellung.md"
```

Das legt (find-or-create) das Tracking-Issue `[Harness Run] immogent-slice-001`
an bzw. verwendet es weiter und hängt Frage/Kontext als Kommentar an.

Ergebnis: Das bereits vorhandene Tracking-Issue des Runs zeigt genau diese
Frage und bleibt bis zum Abschluss des gesamten Runs offen.
