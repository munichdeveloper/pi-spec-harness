# Event-Driven Harness Workflow

## Übersicht

Die pi-spec-harness ist vollständig event-driven ausgelegt. Nach der initialen Spec und Gate-Eröffnung läuft der gesamte Prozess automatisch in GitHub Cloud – von der Spec-Freigabe über die Issue-Erstellung bis zur Copilot-Implementierung.

**Keine Chat-Abhängigkeit, keine manuellen Zwischenschritte – nur Gate-Entscheidungen im Browser.**

---

## Deine manuellen Aufgaben

### 1. Spec schreiben + Run initialisieren

```bash
# Spec in docs/30-specifications/ schreiben (z.B. SPEC-015)
# Mit frontmatter: implementation_assignee: "@github-copilot"

# Run initialisieren
harness init \
  --run-id immogent-run-006-bewertungsmodell \
  --repository munichdeveloper/Immogent \
  --requirement REQ-001 \
  --spec SPEC-015

# Spec-Freigabe-Gate öffnen
harness gate-open \
  --repository munichdeveloper/Immogent \
  --run-id immogent-run-006-bewertungsmodell \
  --gate-id spec-approval \
  --type human \
  --title "SPEC-015 freigeben?" \
  --question "Schwellenwert 70 okay für interessant-Berechnung?"
```

**Ergebnis:** Tracking-Issue wird erstellt, Frage wird als Kommentar gepostet

---

### 2. Spec freigeben (im Browser)

1. Gehe zum Tracking-Issue (Nummer wird in Harness-Output angezeigt)
2. Setze Label `harness:gate-approved`

**Automatisch startet dann:**

| # | Action | Was passiert |
|---|--------|--------------|
| 1 | `harness-gate-trigger.yml` | Triggert `harness resume` |
| 2 | (resume) | Gate wird als `passed` markiert |
| 3 | (spec-update) | SPEC-Datei: `status: review` → `status: approved` |
| 4 | (pr-merge) | PR wird auto-gemergt (mit `--squash --auto`) |
| 5 | `harness-issue-create-trigger.yml` | Triggert nach Gate-Trigger-Erfolg |
| 6 | (issue-create) | `harness issue-create` wird aufgerufen |
| 7 | (phase-transition) | `harness phase --phase implementation` wird aufgerufen |
| 8 | (auto-labels) | Labels `ai:allowed` + `status:ready` auf Issue setzen |
| 9 | `copilot-solve-issue.yml` | Triggert auf Label-Event |
| 10 | (assign) | Assignt `copilot-swe-agent` zur Issue |

**Ergebnis:** Copilot hat Issue, liest vollständigen Body, fängt an zu implementieren

---

### 3. Implementation beobachten

Copilot erstellt automatisch:
- Feature-Branch: `agent/issue-48-bewertungsmodell`
- Code + Tests
- Draft-PR

Wenn PR geöffnet wird:

| # | Action | Was passiert |
|---|--------|--------------|
| 1 | `pr-verification-trigger.yml` | Triggert auf PR-Event |
| 2 | (find-issue) | Findet harness:run Issue via PR-Body-Referenz |
| 3 | (resolve-gate) | `harness gate-resolve --gate-id verification --result passed` |
| 4 | (next-action) | Harness öffnet `merge-approval` Human-Gate (risk:medium) |

**Ergebnis:** Merge-Gate wartet auf deine Entscheidung

---

### 4. Merge freigeben (im Browser)

1. Gehe zum Tracking-Issue
2. Setze Label `harness:gate-approved` (für merge-approval)

**Automatisch:**

| # | Action | Was passiert |
|---|--------|--------------|
| 1 | `harness-gate-trigger.yml` | Triggert `harness resume` |
| 2 | (pr-merge) | PR wird auto-gemergt |
| 3 | (issue-close) | Tracking-Issue bleibt offen für `complete` |

---

### 5. Run abschließen

```bash
harness phase \
  --repository munichdeveloper/Immogent \
  --run-id immogent-run-006-bewertungsmodell \
  --phase complete
```

**Automatisch:**
- Tracking-Issue wird geschlossen
- Run ist archiviert

---

## Vollständige Automation Map

### Trigger → Action → Aktion

| Trigger | GitHub Action | CLI-Befehl | Details |
|---------|---------------|-----------|---------|
| Label `harness:gate-approved` auf Tracking-Issue | `harness-gate-trigger.yml` | `harness resume` | Liest Gate-Entscheidung, wendet sie an |
| ↓ (Resume erfolgreich) | ↓ | `harness phase spec` | Schiebt State weiter |
| ↓ (spec-approval Gate passed) | `harness-gate-trigger.yml` | (auto) | Updated SPEC-Datei: status review→approved |
| ↓ | `harness-gate-trigger.yml` | (auto) | Versucht spec PR zu mergen (`--auto`) |
| ↓ (harness-gate-trigger endet) | `harness-issue-create-trigger.yml` | (triggert per workflow_run) | Checkt Spec-File, generiert Issue-Body |
| ↓ | `harness-issue-create-trigger.yml` | `harness issue-create` | Issue #48 wird erstellt |
| ↓ (issue-create erfolgreich) | `harness-issue-create-trigger.yml` | `harness phase implementation` | Auto-labels, triggert Copilot |
| Label `ai:allowed` + `status:ready` | `copilot-solve-issue.yml` | (gh issue edit --add-assignee) | Copilot wird assignt |
| Copilot erstellt PR | `pr-verification-trigger.yml` | (triggert per PR-Event) | Findet harness:run Issue |
| ↓ (PR erkannt) | `pr-verification-trigger.yml` | `harness gate-resolve verification` | Verification-Gate auto-resolve |
| ↓ (verification passed) | (Harness State Machine) | (auto) | Öffnet merge-approval Gate |
| Label `harness:gate-approved` (Merge) | `harness-gate-trigger.yml` | `harness resume` | Gate wird applied |
| ↓ | `harness-gate-trigger.yml` | (auto) | PR wird gemergt |

---

## Beispiel: Vollständiger RUN-006 Flow

### Einmaliges Setup vor Run-Start

```bash
# 1. SPEC-015 in docs/30-specifications/ schreiben
# - Status: review
# - implementation_assignee: "@github-copilot"
# - Alles dokumentiert

# 2. Repository-Secret setzen (einmalig)
# gh secret set COPILOT_ASSIGN_PAT --repo munichdeveloper/Immogent --body "<fine-grained-pat>"
```

### Ausführung

**Tag 1, 10:00 Uhr**

```bash
harness init \
  --run-id immogent-run-006-bewertungsmodell \
  --repository munichdeveloper/Immogent \
  --requirement REQ-001 \
  --spec SPEC-015

harness gate-open \
  --repository munichdeveloper/Immogent \
  --run-id immogent-run-006-bewertungsmodell \
  --gate-id spec-approval \
  --type human \
  --title "SPEC-015 freigeben?" \
  --question "Schwellenwert 70 für interessante Angebote okay?" \
  --context "Spec: docs/30-specifications/SPEC-015-deterministisches-bewertungsmodell.md" \
  --context "PR: https://github.com/munichdeveloper/Immogent/pull/44"
```

→ **Tracking-Issue #51 erstellt, Gate öffnet sich**

**Tag 1, 10:15 Uhr**

Du genehmigst im Browser: Label `harness:gate-approved` auf Issue #51

→ **GitHub startet automatisch alles:**
- `harness-gate-trigger.yml` resumet
- SPEC-Status: review → approved
- PR #44 mergt
- `harness-issue-create-trigger.yml` erstellt Issue #48
- Labels `ai:allowed` + `status:ready` werden gesetzt
- `copilot-solve-issue.yml` assignt Copilot

**Tag 1, 10:30 Uhr**

Copilot fängt automatisch an:
- Branch: `agent/issue-48-bewertungsmodell`
- Code wird geschrieben
- Tests werden hinzugefügt
- PR #50 wird geöffnet

→ **`pr-verification-trigger.yml` triggert automatisch:**
- Findet Referenz zu Issue #48
- Ruft `harness gate-resolve verification` auf
- Merge-Gate öffnet sich

**Tag 1, 15:00 Uhr**

PR ist ready (alle Checks grün), du genehmigst: Label `harness:gate-approved` auf Tracking-Issue #51

→ **Automatisch:**
- `harness-gate-trigger.yml` mergt PR #50
- Run ist bereit zum Abschluss

**Tag 1, 15:30 Uhr**

```bash
harness phase \
  --repository munichdeveloper/Immogent \
  --run-id immogent-run-006-bewertungsmodell \
  --phase complete
```

→ **Automatisch:**
- Tracking-Issue #51 wird geschlossen
- Run ist archiviert

---

## Fehlerbehandlung

### Wenn ein Gate/Action fehlschlägt

Jede Action postet einen Kommentar auf dem Tracking-Issue bei Fehler mit:
- Fehlermeldung
- Link zum Action-Log

**Du siehst es sofort im Issue**, nicht nur im CLI.

### Wenn du ein Gate ablehnen willst

```bash
harness gate-open \
  --repository munichdeveloper/Immogent \
  --run-id immogent-run-006-bewertungsmodell \
  --gate-id spec-approval \
  --type human
# ... dann Label harness:gate-rejected setzen
```

---

## Konfiguration

### Secrets (einmalig pro Repository)

```bash
# Für Copilot-Zuweisung (benötigt: Issues Read & Write, dieses Repo only)
gh secret set COPILOT_ASSIGN_PAT --repo <owner>/<repo> --body "<pat>"
```

### Spec-Frontmatter

```yaml
---
id: SPEC-015
type: software-spec
title: ...
status: review              # wird zu approved nach Gate
implementation_assignee: "@github-copilot"  # Standard
---
```

---

## Labels (Immogent)

| Label | Bedeutung |
|-------|-----------|
| `harness:run` | Issue ist Tracking-Issue für einen Run |
| `harness:gate` | Gate ist offen |
| `harness:gate-approved` | Gate wurde freigegeben |
| `harness:gate-rejected` | Gate wurde abgelehnt |
| `status:needs-human` | Wartet auf Human-Gate-Entscheidung |
| `ai:allowed` | Issue kann von Copilot bearbeitet werden |
| `status:ready` | Issue ist ready für Copilot |

---

## Troubleshooting

### "Tracking-Issue Title does not match '[Harness Run] <run-id>'"

→ Der Titel des Tracking-Issues ist nicht korrekt formatiert
→ Sollte automatisch sein, aber wenn manuell: `[Harness Run] immogent-run-006-bewertungsmodell`

### "COPILOT_ASSIGN_PAT secret is not set"

→ Repository-Secret fehlt
→ Siehe Secrets-Sektion

### "No open harness:run issue found"

→ Kein offenes Tracking-Issue für einen Run
→ Hast du `harness init` + `harness gate-open` aufgerufen?

### Copilot wird nicht assignt

→ Check: Sind beide Labels `ai:allowed` + `status:ready` gesetzt?
→ Check: Läuft `copilot-solve-issue.yml` (Action Log)?
→ Check: Secret `COPILOT_ASSIGN_PAT` richtig konfiguriert?

---

## Weitere Ressourcen

- [SKILL.md](../skills/pi-spec-harness/SKILL.md) – Agent-Protokoll
- [human-gates.md](./human-gates.md) – Gate-Mechanik im Detail
- [workflow.md](./workflow.md) – State Machine & Phasen
- [pi-spec-harness README](../README.md) – Harness-Übersicht

---

## Appendix: Agent Failure Recovery (RUN-006 Learnings)

### Scenario: Agent Implementation Fails Tests

When Copilot (or another agent) opens a PR with failing tests:

```
┌─ Workflow Automation ────────────────────────┐
│                                              │
│  Check Failure (E2E Test, etc.)              │
│         ↓                                    │
│  agent-cherry-pick-implementation.yml        │
│    ├─ Detect failing draft PR                │
│    ├─ Extract commits from PR branch         │
│    ├─ Cherry-pick to main                    │
│    ├─ Post status comment                    │
│    └─ PUSH to main ✓ (code preserved)        │
│         ↓                                    │
│  agent-fix-failing-tests.yml (parallel)      │
│    ├─ Post detailed error feedback           │
│    ├─ Close the draft PR                     │
│    └─ Re-trigger agent assignment            │
│         ↓                                    │
│  copilot-solve-issue.yml                     │
│    └─ Agent re-assigned with labels          │
│         ↓                                    │
│  Agent opens new PR (on fresh foundation)    │
│    ├─ Retry implementation with fixes        │
│    ├─ Run tests again                        │
│    └─ If passes: proceed to merge ✓          │
│         ↓                                    │
│  Max 3 automatic retries                     │
│    └─ If still failing: escalate to human gate
│                                              │
└──────────────────────────────────────────────┘
```

### Key Properties

1. **Code Preservation**: Implementation commits are cherry-picked to main **before** PR closure
2. **Automatic Retry**: No manual intervention needed (except gate decisions)
3. **Iteration Tracking**: Each attempt is counted in `state.iterations[]`
4. **Escalation**: After 3 failed attempts, human gate opens for manual decision
5. **Audit Trail**: All steps logged in PR comments + Harness state

### Commits Involved

- `agent-cherry-pick-implementation.yml`: Preserve code on failure
- `agent-fix-failing-tests.yml`: Notify and retry
- `copilot-solve-issue.yml`: Re-assign agent
- State Machine: Track iterations and escalate

### Example: RUN-006

| Event | Workflow | Result |
|-------|----------|--------|
| PR #50 fehlgeschlagen | agent-cherry-pick-implementation | 2 commits → main ✓ |
| E2E-Test-Fehler | agent-fix-failing-tests | Feedback gepostet, PR #50 geschlossen |
| Labels re-set | copilot-solve-issue | Copilot erneut assignet |
| PR #51 geöffnet | (automatic) | Neue Implementierung |
| All tests grün | (automatic) | PR #51 gemerged |

**Result:** Zero code loss, zero manual coding, full automation.

