# Human Gates: GitHub Issues als einzige Entscheidungsschicht

## Motivation

Bei rein chat-basierter Arbeit verschwimmen Entscheidungen im Gesprächsfluss:
es ist im Nachhinein schwer erkennbar, wann genau eine Freigabe erteilt wurde
und wofür genau. Dieses Repository erzwingt stattdessen: **jede
Entscheidung, die einen Menschen braucht, ist ein eigenes, benanntes GitHub
Issue** im Zielrepository, mit eindeutigem Auflösungsmechanismus.

## Protokoll

1. Pi erkennt Entscheidungsbedarf (Produktentscheidung, Kosten, Secrets,
   Risiko, Merge bei `risk >= medium`, Eskalation nach 3 Iterationen,
   Unklarheit im Requirement/Spec/Issue).
2. Pi registriert ein Gate vom Typ `human` im Run-State und ruft
   `openHumanGateIssue` auf (`harness gate-open --type human ...`).
3. Es entsteht genau ein GitHub Issue:
   - Titel: `[Human Gate] <run-id> · <title>`
   - Labels: `harness:gate`, `status:needs-human`
   - Body: Frage, Kontext, Links auf Run/Requirement/Spec/Issue/PR
4. Pi verweist im Chat kurz auf das Issue und pausiert die Arbeit an diesem
   Run.
5. Ein Mensch beantwortet die Frage **ausschließlich** durch Setzen von:
   - `harness:gate-approved` → Freigabe, oder
   - `harness:gate-rejected` → Ablehnung.
   Kommentare sind für Kontext willkommen, zählen aber nicht als Entscheidung.
6. `harness resume` (oder erneutes Aufrufen durch Pi) pollt das Issue,
   übernimmt die Entscheidung in den Run-State (`applyGateDecision`),
   kommentiert das Issue mit dem Ergebnis und schließt es bei Freigabe
   automatisch.

## Warum Labels statt Kommentartext?

Labels sind eindeutig, maschinenlesbar und lassen sich nicht versehentlich
als Freigabe fehlinterpretieren (anders als ein Kommentar wie "sieht gut
aus"). Das entspricht der alten Harness-Regel, dass ein Merge-Gate niemals
ein offenes Human-Gate stillschweigend überspringen darf -- hier technisch
erzwungen, nicht nur dokumentiert.

## Beispiel

```bash
npm run harness -- gate-open \
  --state artifacts/harness/immogent-slice-001.json \
  --gate-id merge-approval \
  --type human \
  --title "Merge PR #42 freigeben" \
  --question "PR #42 implementiert SPEC-011 (Kaufprofil-Wizard, risk: medium). CI grün, keine offenen Review-Threads. Freigabe zum Merge?" \
  --context "PR: https://github.com/munichdeveloper/Immogent/pull/42" \
  --context "Spec: docs/30-specifications/SPEC-011-authentifizierte-kaufprofil-erstellung.md"
```

Ergebnis: ein neues Issue im Immogent-Repo, das genau diese eine Frage stellt
und bis zur Label-Entscheidung offen bleibt.
