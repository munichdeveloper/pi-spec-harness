---
id: SPEC-011
type: software-spec
title: Deterministischer Stall-Watchdog für hängende Runs
status: approved
owner: engineering
risk: medium
requirements:
  - REQ-011
implementation_assignee: "@github-copilot"
created: 2026-08-13
updated: 2026-08-23
---

# SPEC-011: Deterministischer Stall-Watchdog für hängende Runs

## Zusammenfassung

Ein neuer, `schedule`-getriggerter Workflow ruft periodisch ausschließlich
einen deterministischen CLI-Befehl (`harness watchdog-scan`) auf. Dieser
Befehl enthält keinen KI-Aufruf, scannt repo-weit alle offenen
Tracking-Issues und erkennt rein regelbasiert, für welche Runs eine
automatische Folgeaktion überfällig ist. Nur für tatsächlich erkannte,
hängende Runs löst der Befehl eine bereits bestehende, begrenzte Automation
erneut aus (aktuell: `agent-assign`). Der Watchdog wird als Eintrag im
bestehenden Workflow-Vorlagen-Katalog (SPEC-006) installierbar und nutzt den
bestehenden Audit-Mechanismus (SPEC-005) für jeden tatsächlichen Anstoß.

Die Spec implementiert REQ-011.

## Technische Entscheidungen

### 1. Reine Erkennungsfunktion

Neues Modul `src/watchdog/stall-detection.ts` mit einer reinen Funktion

```ts
detectStalledRuns(
  states: RunState[],
  now: string,
  options: { staleAfterMinutes: number; maxNudges: number },
): StalledRunFinding[]
```

Kein I/O, kein GitHub-Zugriff — analog zu `computeNextAction` in
`src/state/state-machine.ts` (siehe `AGENTS.md`, Grundsätze). Ein Run ist
ein `StalledRunFinding`, wenn **alle** zutreffen:

1. `state.phase !== "complete"`.
2. Es existiert kein Gate mit `type === "human"` und `result === "pending"`
   auf diesem Run (offene menschliche Gates blockieren den Watchdog
   vollständig — AC-04).
3. Weder `needsGateReconciliation(state)` noch
   `needsDeliveryMergeReconciliation(state)` ist wahr. Auch
   `computeNextAction(state).action === "persist-run-documentation"` schließt
   einen Watchdog-Fund aus. Diese Zustände gehören zum bestehenden
   `harness reconcile`-Sweep.
4. Die Phase erwartet eine bekannte, deterministisch benennbare
   automatische Aktion (initial ausschließlich: `phase === "implementation"`
   und `agent-assign` wurde noch nicht erfolgreich verifiziert. Die dafür
   maßgebliche Assignment-Evidenz wird durch Issue #62 kanonisch definiert;
   ein offenes `agent-assign-unavailable`- oder
   `agent-assign-unverified`-Human-Gate schließt den Run bereits nach Regel 2
   aus und darf niemals durch den Watchdog umgangen werden.
5. `now - state.updatedAt >= staleAfterMinutes` (Minutenvergleich auf
   ISO-8601-Zeitstempeln).
6. Die Anzahl bisheriger Watchdog-Anstöße für **diese konkrete Aktion**
   (siehe `RunState.watchdog.nudges`, Abschnitt 2) ist `< maxNudges`
   (Default `3`, konsistent mit dem bestehenden Iterationslimit aus
   REQ-001, aber ein eigener, getrennter Zähler — ein Watchdog-Anstoß ist
   keine Korrekturiteration im Sinne von REQ-001).

`staleAfterMinutes` (Default `45`) und `maxNudges` (Default `3`) sind
CLI-Optionen mit Default, keine hartkodierten Werte.

### 2. Neues Zustandsfeld `watchdog`

`RunState` (Schema-Version-Bump) erhält ein optionales Feld:

```ts
watchdog?: {
  nudges: Array<{
    actionKey: string;       // z. B. "agent-assign"
    dispatchedAt: string;    // ISO-8601
    outcome: "dispatched" | "already-in-progress" | "failed";
  }>;
};
```

Bestehende Zustände ohne dieses Feld gelten als `{ nudges: [] }`
(rückwärtskompatibel, kein Migrationsschritt für vorhandene Tracking-Issues
nötig). Der Verlauf wird wie der Iterationsverlauf append-only geführt und
lebt kanonisch im Tracking-Issue-Body — kein separater Speicher.

### 3. CLI-Befehl `watchdog-scan`

Neuer Befehl `harness watchdog-scan --repository <owner/repo>
[--stale-after-minutes <n>] [--max-nudges <n>] [--dry-run]`:

1. Lädt alle offenen Issues mit Label `harness:run` über die bestehende
   `github.findIssuesWithLabels()`-Funktion (identisch zu `cmdReconcile`).
2. Parst je Issue den kanonischen `RunState` aus dem Issue-Body.
3. Ruft `detectStalledRuns()` auf der vollständigen Liste auf.
4. Für jeden Fund (sofern nicht `--dry-run`): ruft exakt denselben,
   bestehenden Codepfad wie `cmdAgentAssign` auf (kein Duplikat der
   Zuweisungslogik), mit der Run-ID und dem im State gebundenen Issue.
5. Schreibt bei jedem tatsächlichen Anstoß einen `watchdog.nudges`-Eintrag
   in den State und liefert Ergebnis
   `{ schemaVersion, command: "watchdog-scan", result: { scanned, stalled,
   nudged, skipped, escalated }, nextAction }`.
6. Ein Run, dessen `maxNudges` bereits ausgeschöpft ist, wird nicht erneut
   angestoßen; stattdessen öffnet der Befehl — sofern noch nicht vorhanden —
   ein Gate `watchdog-exhausted` vom Typ `human` mit `status:needs-human`
   (wiederverwendet das bestehende Eskalationsmuster aus REQ-001 AC-05/AC-06,
   nicht das REQ-001-Iterationslimit selbst).
7. `watchdog-scan` enthält keinerlei KI-/LLM-Aufruf. Der ausgelöste
   Agentenlauf selbst (z. B. Copilot nach `assignCodingAgent`) läuft wie
   bisher vollständig außerhalb dieses Befehls.

### 4. Zeitgesteuerter Workflow und Installations-Vorlage

- Neuer reusable Workflow `.github/workflows/stall-watchdog.yml`
  (`workflow_call`, Inputs: `repository` (Default `github.repository`),
  `stale-after-minutes` (Default `45`), `max-nudges` (Default `3`)). Er
  checkt den gepinnten Harness-Ref aus und ruft `npm run harness --
  watchdog-scan` auf.
- Neuer Katalogeintrag `stall-watchdog` in `WORKFLOW_TEMPLATE_CATALOG`
  (SPEC-006), installierbar über `harness init --install-workflows
  stall-watchdog`. Die generierte dünne Referenzdatei im Zielrepo enthält:
  ```yaml
  on:
    schedule:
      - cron: "*/30 * * * *"
    workflow_dispatch: {}
  ```
  Im Harness-eigenen Repository kann derselbe Befehl im bereits vorhandenen
  vertrauenswürdigen Reconcile-Schedule laufen. Zielrepositories erhalten den
  Schedule ausschließlich über diese explizit installierte Vorlage.
- Berechtigungen minimal: `issues: write` (State- und Gate-Updates),
  `contents: read` (Checkout). Kein `contents: write`, kein
  `secrets: inherit` (Lehre aus PR #31, siehe Betriebshinweis unten).
- `concurrency: group: harness-watchdog-${{ inputs.repository }}`,
  `cancel-in-progress: false` verhindert überlappende Scans desselben
  Repositories.

### 5. Audit-Integration (REQ-005)

Nur ein tatsächlicher Anstoß (nicht jeder Scan-Lauf ohne Befund) erzeugt
ein Audit-Ereignis, um Spam zu vermeiden:

- Prozesskennung: `PROCESS_RECONCILIATION` für Erkennung/Eskalation und
  `AGENT_ASSIGNMENT` für den tatsächlichen Anstoß,
- Akteur: `GITHUB_ACTIONS`,
- Zugriffsrolle: `GITHUB_ACTIONS_TOKEN`,
- Prozessinstanz: qualifizierte Run-ID,
- Begründung: konkreter überschrittener Schwellwert (Phase, Minuten seit
  `updatedAt`, `actionKey`),
- Ergebnis: `dispatched` / `already-in-progress` / `failed`,
- Korrelation: Tracking-Issue, Implementierungs-Issue, sofern vorhanden PR.

Eine Eskalation (`watchdog-exhausted`-Gate) erzeugt zusätzlich ein eigenes
Audit-Ereignis mit Ergebnis `escalated`.

### 6. Abgrenzung zu `harness reconcile`

`reconcile` bleibt für verpasste Gate-Label-Events, bestätigte aber noch nicht
persistierte Delivery-Merges und ausstehende Run-Dokumentation zuständig.
`watchdog-scan` prüft ausschließlich Runs, für die keine dieser
Reconcile-Aktionen fällig ist. Beide Pfade schließen sich pro Run gegenseitig
aus; das wird durch einen gemeinsamen Contract-Test abgesichert.

### 7. Betriebshinweis

Der Katalogeintrag installiert die Referenzdatei mit `schedule`-Trigger
genau wie jede andere Vorlage über den bestehenden Managed-Marker-
Mechanismus (SPEC-006) — `create`/`noop`/`update-managed`/`conflict`. Ein
Repository, das die Vorlage nicht installiert, erhält keinen Watchdog; es
gibt keinen impliziten, ungefragten globalen Cron-Job im Harness-Repo
selbst.

## Technische Akzeptanzkriterien

- TAC-01: `detectStalledRuns()` liefert für einen synthetischen Zustand mit
  `phase: "implementation"`, keiner Assign-Evidenz, `updatedAt` älter als
  `staleAfterMinutes` und `nudges.length < maxNudges` genau einen Fund.
- TAC-02: Derselbe Zustand mit einem offenen `type: "human"`-Gate liefert
  keinen Fund (AC-04).
- TAC-03: Derselbe Zustand mit Gate-Reconciliation, Delivery-Merge-
  Reconciliation oder fälliger Run-Dokumentation liefert keinen Fund
  (Abgrenzung zu `reconcile`, Abschnitt 6).
- TAC-04: Derselbe Zustand mit `updatedAt` innerhalb des Schwellwerts
  liefert keinen Fund.
- TAC-05: Derselbe Zustand mit `nudges.length === maxNudges` liefert keinen
  erneuten Anstoß-Fund, sondern eine Eskalationsmarkierung.
- TAC-06: `phase: "complete"` liefert nie einen Fund.
- TAC-07: `watchdog-scan --dry-run` verändert keinen State und triggert
  keine Agentenzuweisung, meldet aber dieselben Funde wie ohne `--dry-run`.
- TAC-08: `watchdog-scan` ohne `--dry-run` ruft für jeden Fund exakt einmal
  denselben Codepfad wie `cmdAgentAssign` auf und schreibt genau einen
  `watchdog.nudges`-Eintrag.
- TAC-09: Ein zweiter Scan unmittelbar nach einem erfolgreichen Anstoß
  erzeugt für denselben Run keinen zweiten Anstoß (Cool-down über
  `dispatchedAt` plus `staleAfterMinutes`, AC-06).
- TAC-10: Erreichen von `maxNudges` öffnet genau ein Gate
  `watchdog-exhausted`; ein bereits offenes derartiges Gate wird nicht
  doppelt geöffnet.
- TAC-11: Jeder tatsächliche Anstoß erzeugt ein Audit-Ereignis mit allen in
  Abschnitt 5 genannten Feldern; ein Scan ohne Fund erzeugt kein
  Audit-Ereignis.
- TAC-12: `stall-watchdog` ist über `WORKFLOW_TEMPLATE_CATALOG` auffindbar
  und über `harness init --install-workflows stall-watchdog` installierbar;
  die erzeugte Referenzdatei folgt dem Managed-Marker-Muster aus SPEC-006
  und enthält einen `schedule`-Trigger.
- TAC-13: Ein Contract-Test belegt, dass kein Run gleichzeitig von
  `reconcile` und `watchdog-scan` als zuständig erkannt wird (Abschnitt 6).
- TAC-14: Die reusable Workflow-Datei deklariert ausschließlich `issues:
  write` und `contents: read`, kein `secrets: inherit`.

## Verifikation

- `npm run check`,
- Unit-Tests für `detectStalledRuns()` mit den Fixtures aus TAC-01 bis
  TAC-06,
- Unit-/Contract-Test für die Trennschärfe zu allen vom bestehenden
  `reconcile`-Sweep behandelten Zuständen (TAC-13),
- Contract-Test für `watchdog-scan --dry-run` vs. Normalmodus (TAC-07,
  TAC-08),
- Contract-Test für Cool-down/Idempotenz bei wiederholtem Scan (TAC-09),
- Contract-Test für Eskalation nach Ausschöpfung (TAC-10),
- Workflow-Vertragstest für `stall-watchdog.yml` (Trigger, Berechtigungen,
  Concurrency-Gruppe, Katalogeintrag),
- synthetischer Smoke-Lauf: künstlich gealterter Run wird erkannt, Anstoß
  ausgelöst, Audit-Ereignis erzeugt, zweiter Scan bleibt No-op.

## Rollout

1. SPEC-011 und REQ-011 nach menschlicher Freigabe mergen.
2. Issue #62 abschließen, damit Assignment-Evidenz und Retry-Vertrag
   kanonisch feststehen.
3. `detectStalledRuns()`, `watchdog`-Zustandsfeld und `watchdog-scan`
   implementieren, inklusive Tests.
4. Reusable Workflow und Katalogeintrag ergänzen.
5. Vorlage zunächst nur im Harness-eigenen Repository installieren
   (Self-Hosting, siehe REQ-009) und mit einem synthetisch gealterten Run
   beobachten.
6. Nach nachgewiesener Stabilität optionale Installation in weiteren
   Zielrepositories (z. B. Immogent) als separater, bewusster Schritt.

## Rollback

Die Vorlage ist über `--install-workflows stall-watchdog` einzeln
aktivierbar und durch Entfernen der installierten Referenzdatei bzw.
Deaktivieren des `schedule`-Triggers folgenlos abschaltbar. Persistenter
Watchdog-Zustand und Audit-Historie bleiben zur Nachvollziehbarkeit
erhalten. Kein Rückbau bestehender Runs nötig, da der Watchdog keine
irreversiblen Effekte außerhalb der bereits bestehenden, begrenzten
`agent-assign`-Automation auslöst.

## Nicht-Ziele

- KI-gestützte Einschätzung, ob ein Run hängt,
- Auflösen oder Umgehen menschlicher Gates,
- ein zusätzlicher externer Scheduler-, Queue- oder Datenbankdienst,
- Ersatz von `harness reconcile`,
- Anstoßen bereits abgeschlossener oder bereits eskalierter Runs,
- weitere automatisch anstoßbare Aktionstypen über `agent-assign` hinaus in
  dieser ersten Ausbaustufe (z. B. automatischer Retry einer fehlgeschlagenen
  Iteration bleibt künftiger Arbeit vorbehalten).
