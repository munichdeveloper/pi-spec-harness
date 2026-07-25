# Regeln für KI-Agenten in diesem Repository

Dieses Repository *implementiert* den Harness. Für die Regeln, wie der
Harness beim Arbeiten an einem Zielrepo (z. B. Immogent) zu benutzen ist,
siehe [`skills/pi-spec-harness/SKILL.md`](skills/pi-spec-harness/SKILL.md).

## Grundsätze

- Jede GitHub-Schreibaktion muss als benannte, auditierbare Funktion in
  `src/github/gh.ts` existieren. Keine generische "führe beliebigen gh-Befehl
  aus"-Eskapiermöglichkeit.
- Human Gates sind ausschließlich über GitHub-Issue-Labels auflösbar
  (`harness:gate-approved` / `harness:gate-rejected`). Kein Code darf eine
  Chat-Antwort oder einen Kommentartext als Freigabe interpretieren.
- `computeNextAction` in `src/state/state-machine.ts` ist eine reine
  Funktion: kein I/O, kein GitHub-Zugriff. Seiteneffekte (State speichern,
  GitHub ansprechen) gehören in die CLI-Befehle oder das Skill-Protokoll,
  nicht in die State-Machine selbst.
- `saveRunState` prüft vor jedem Schreiben Datenhygiene
  (`src/state/hygiene.ts`). Diese Prüfung darf nicht umgangen werden.
- Neue CLI-Befehle liefern `{ schemaVersion, command, result, nextAction }`.
- Tests für neues Verhalten in `test/` ergänzen; `npm run check` muss grün
  bleiben.

## Definition of Done für Änderungen an diesem Repo

- `npm run check` (typecheck + lint + test) ist grün.
- Neue Gate- oder State-Übergänge sind mit Unit-Tests abgedeckt.
- README/Docs sind aktualisiert, wenn sich das Protokoll ändert.
