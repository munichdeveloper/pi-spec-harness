# 🔄 Handover für neuen Agent: RUN-006 → RUN-007

**Stand:** 2026-07-27, alle Tests grün ✅

---

## 📋 Was geschah in RUN-006? (ABGESCHLOSSEN)

**Requirement:** REQ-001 (Immogent-Immobilienangebote automatisiert bewerten)  
**Spec:** SPEC-015 (Deterministisches Bewertungsmodell)  
**Zeitraum:** 2026-07-25 bis 2026-07-27  
**Status:** ✅ COMPLETE

### Ergebnis

- Neue Feature: Offers automatisch in 3 Kategorien bewerten (`interesting`, `possibly_interesting`, `excluded`)
- UI-Filter zeigt standardmäßig nur `interesting`-Angebote
- Komplette Bewertungslogik in `src/domain/offer-evaluation.ts` + `src/application/offer-evaluation-service.ts`
- Database Migration 0008: `evaluation_status`, `evaluatedAt`, `evaluationCriteria`, `evaluated_against_profile_version`
- E2E-Tests updatet für neue Filtermechaniken

### Issues erstellt/geschlossen

- ✅ #45 `[Harness Run] immogent-run-006-bewertungsmodell` — Tracking Issue (jetzt closed)
- ✅ #48 `SPEC-015: Implement deterministic offer evaluation model` — Implementation Issue (jetzt closed)
- ✅ PR #51 — Implementation (merged)

---

## 🔍 Was muss ein neuer Agent wissen?

### 1. **Der Harness (pi-spec-harness)**

Das ist ein **vollautomatisiertes Workflow-System** für spezifikationsgetriebene Entwicklung.

**Quelle:** `/IdeaProjects/pi-spec-harness/`

**Grundkonzepte:**
- Jeder "Run" = ein GitHub Issue mit Label `harness:run`
- Run-State lebt im Issue-Body (JSON, nicht in Dateien)
- Alle Entscheidungen via GitHub Labels (`harness:gate-approved`, `harness:gate-rejected`)
- Nach Gate-Approval: Automatische Workflows triggern → Copilot-Zuweisung → Implementation → Tests → Merge

**Wichtige Befehle:**
```bash
# Lokal, im pi-spec-harness Repo:
npm run harness -- init \
  --run-id immogent-run-007-NAME \
  --repository munichdeveloper/Immogent \
  --requirement REQ-001 \
  --spec SPEC-XXX

npm run harness -- status \
  --repository munichdeveloper/Immogent \
  --run-id immogent-run-007-NAME

npm run harness -- gate-open \
  --repository munichdeveloper/Immogent \
  --run-id immogent-run-007-NAME \
  --gate-id spec-approval \
  --type human \
  --title "SPEC-XXX freigeben?" \
  --question "Schwellenwerte okay?"
```

**Dokumentation:**
- `README.md` — Übersicht
- `docs/event-driven-workflow.md` — Workflow von außen (user-facing)
- `docs/implementation-guide.md` — ⭐ FÜR DICH! Fallstricke & Checklisten
- `AGENTS.md` — Regeln für Agent-Implementation

---

### 2. **Das Immogent-Projekt**

**Repo:** `munichdeveloper/Immogent` (https://github.com/munichdeveloper/Immogent)

**Tech Stack:**
- Next.js 14 (TypeScript)
- PostgreSQL + Drizzle ORM
- Clerk Auth
- Playwright E2E Tests
- GitHub Actions für CI/CD

**Wichtige Dateien:**

**Specs:**
```
docs/30-specifications/
├── SPEC-015-deterministisches-bewertungsmodell.md  ← Das ist der aktuelle Status
├── ... weitere Specs ...
```

**Domain Logic:**
```
src/domain/
├── offer-evaluation.ts           ← Bewertungs-Logik (interessant/möglich/ausgeschlossen)
├── search-profile.ts             ← Suchprofil-Modell
└── ...

src/application/
├── offer-evaluation-service.ts   ← Service (orchestriert Repo + Domain)
└── ...
```

**Repositories:**
```
src/infrastructure/
├── postgres-inbound-offer-repository.ts  ← Angebote laden/speichern
├── postgres-search-profile-repository.ts
└── ...
```

**UI:**
```
src/app/search-profiles/[id]/page.tsx  ← Filter-Logik (rechts oben: "Alle / Interessant / Möglich / Ausgeschlossen")
```

**DB Migrationen:**
```
drizzle/
├── 0000_initial.sql
├── 0001_...
├── ...
├── 0008_offer-evaluation.sql      ← NEU in RUN-006
├── meta/
│   ├── _journal.json              ← KRITISCH! Alle Migrationen müssen hier registriert sein
│   └── 0008_snapshot.json         ← Snapshot der neuen Migration
└── ...
```

**Tests:**
```
src/e2e/search-profile-wizard.spec.ts  ← E2E Tests
test/                                  ← Unit Tests
```

---

### 3. **Git-Status**

**Main Branch:** `4feb59b` (letzter Commit: `c835093 fix: use filter=all in E2E...`)

**Letzter Merge:** PR #51 (Copilot-Implementation von RUN-006)

**Offene Branches:** Keine (alle merged/closed)

---

### 4. **Wichtige Lessons Learned (RUN-006)**

⚠️ **Diese Fehler könnten wiederkommen — vermeiden!**

#### A. Database Migrations müssen VOLLSTÄNDIG synchron sein

**Das Problem:** Migration 0008 war geschrieben, aber:
- ❌ Nicht in `drizzle/meta/_journal.json`
- ❌ `src/db/schema.ts` nicht aktualisiert
- ❌ `INSERT`-Statements unvollständig
- ❌ Type-Mappings fehlten

**Checklist für zukünftige DB-Changes:**

```bash
# 1. SQL-Migration schreiben
drizzle/000X_feature.sql

# 2. JOURNAL-EINTRAG (MUSS SEIN!)
# Bearbeite: drizzle/meta/_journal.json
# Füge ein:
{
  "idx": <N>,
  "version": "5",
  "digest": "<hash>",
  "when": 1234567890000
}

# 3. Snapshot erstellen
drizzle/meta/000X_snapshot.json
# (Zeige komplette neue/geänderte Tabellenstatus)

# 4. Schema aktualisieren
src/db/schema.ts
# - Neue Spalten mit expliziten Typen
# - Enum-Werte (wenn relevant)
# - nullable / notNull synchron zur Migration

# 5. INSERT-Statements überprüfen
grep -r "INSERT INTO offers" src/infrastructure/
# Alle neuen Spalten aufzählen (auch nullable!)

# 6. SELECT + Type-Mapping
# OfferRow Type aktualisieren
# mapOfferRow() mit expliziter Konvertierung:
function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value as string);
}

# 7. Testen!
npm run test
```

#### B. Type Conversions sind nicht automatic

```typescript
// ❌ FALSCH
evaluatedAt: row.evaluatedAt as Date

// ✅ RICHTIG
evaluatedAt: row.evaluatedAt instanceof Date 
  ? row.evaluatedAt 
  : row.evaluatedAt ? new Date(row.evaluatedAt as string) : null
```

postgres.js konvertiert Timestamps nicht in allen Query-Pfaden automatisch.

#### C. E2E-Tests vs. neue Business Logic

**Problem:** Alte Tests schreiben Daten, die unter neuer Logik herausgefiltert werden.

**Beispiel:** Ein Miet-Angebot mit `locality: "München"` (keine PLZ) an ein Profil mit `location: { postal_code: "80331" }` → korrekt als `excluded` bewertet → unsichtbar im Standard-Filter.

**Lösungen (in Priorität):**
1. **Test-Daten reparieren:** `locality: "München"` → `locality: "80331 München"`
2. **Filter-Parameter verwenden:** `await page.goto(\`\${url}?filter=all\`)`
3. **Assertions aktualisieren:** Wenn excluded-Status korrekt ist, auf `not.toBeVisible()` prüfen

Siehe: `docs/implementation-guide.md` im Harness für Details.

---

### 5. **Notwendige Secrets/Credentials**

Diese müssen **bereits im Immogent-Repo** konfiguriert sein:

**`COPILOT_ASSIGN_PAT`** (fine-grained personal access token)
- Scope: `Issues: Read & Write` (nur dieses Repo)
- Wird von `copilot-solve-issue.yml` verwendet
- Falls nicht vorhanden: Owner muss es setzen in `Settings → Secrets and variables → Actions`

**GitHub Actions:** Alle Secrets sollten **automatisch** über Umgebungsvariablen erreichbar sein.

---

### 6. **GitHub Actions Workflows (automatisch)**

Diese laufen nach bestimmten Events:

**`harness-gate-trigger.yml`**
- Triggert: Wenn Label `harness:gate-approved` oder `harness:gate-rejected` gesetzt wird
- Macht: `harness resume` → Gate auflösen → SPEC updaten → PR mergen

**`harness-issue-create-trigger.yml`**
- Triggert: Wenn vorige Workflow erfolgreich
- Macht: `harness issue-create` → Creates Implementation Issue → Setzt Labels

**`copilot-solve-issue.yml`**
- Triggert: Wenn Issue Labels `ai:allowed` + `status:ready` hat
- Macht: Assignt `copilot-swe-agent`

**`pr-verification-trigger.yml`**
- Triggert: Wenn PR geöffnet wird
- Macht: Findet harness:run Issue → Auto-resolves verification gate

**`agent-cherry-pick-implementation.yml`**
- Triggert: Wenn Copilot-PR failet
- Macht: Cherry-pickt Code zu main → Schließt Draft-PR → Re-triggert Copilot

**`agent-fix-failing-tests.yml`**
- Triggert: Workflow Fehler
- Macht: Postet Feedback → Togglet Labels zum Re-triggern

---

## 🚀 Erste Schritte für nächsten Agent (RUN-007)

### Setup (einmalig)

```bash
# 1. Beide Repos clonen
cd ~/workspace
git clone https://github.com/munichdeveloper/pi-spec-harness.git
git clone https://github.com/munichdeveloper/Immogent.git

# 2. In pi-spec-harness:
cd pi-spec-harness
npm install
npm run check  # Muss grün sein

# 3. In Immogent:
cd ../Immogent
npm install
npm run check  # Muss auch grün sein
```

### Workflow für neue Spec (z.B. RUN-007)

```bash
# 1. Spec schreiben (in Immogent)
# Datei: docs/30-specifications/SPEC-XXX-name.md
# Mit Frontmatter:
# ---
# specId: SPEC-XXX
# title: Feature Name
# status: draft
# version: 1.0.0
# implementation_assignee: "@github-copilot"
# ---

# 2. Harness Init (in pi-spec-harness)
cd ~/workspace/pi-spec-harness
npm run harness -- init \
  --run-id immogent-run-007-feature-name \
  --repository munichdeveloper/Immogent \
  --requirement REQ-001 \
  --spec SPEC-XXX

# 3. Gate öffnen
npm run harness -- gate-open \
  --repository munichdeveloper/Immogent \
  --run-id immogent-run-007-feature-name \
  --gate-id spec-approval \
  --type human \
  --title "SPEC-XXX freigeben?" \
  --question "Fachliche Frage an Product Owner?"

# 4. Warten → Im Browser:
#    - Gehe zum Tracking-Issue (Nummer wird angezeigt)
#    - Lese die Spezifikation
#    - Setze Label: harness:gate-approved
#    → Automatischer Workflow startet!

# 5. Beobachten (optional, für Debugging)
npm run harness -- status \
  --repository munichdeveloper/Immogent \
  --run-id immogent-run-007-feature-name
```

---

## ✅ Checkliste für neuen Agent

- [ ] Beide Repos gecloned
- [ ] `npm install` in beiden
- [ ] `npm run check` grün in beiden
- [ ] `docs/implementation-guide.md` im Harness gelesen
- [ ] Secrets im Immogent-Repo vorhanden (`COPILOT_ASSIGN_PAT`)
- [ ] Verständnis: "Run = GitHub Issue mit harness:run Label"
- [ ] Verständnis: "Alle Entscheidungen via Label, nicht Chat"
- [ ] GitHub Actions Workflows überflogen (`inmogent/.github/workflows/`)
- [ ] DB-Migration Checkliste verstanden

---

## 🆘 Was tun bei Problemen?

### "Harness gibt 'not found' zurück"

→ Repo-Zugriff? Token Scope (`repo` scope nötig)?

```bash
gh auth status
gh repo view munichdeveloper/Immogent
```

### "Issue wurde nicht erstellt"

→ Checke Harness-Logs, check GitHub Actions Run für `harness-issue-create-trigger.yml`

### "Copilot-Assignement funktioniert nicht"

→ `COPILOT_ASSIGN_PAT` Set? Check: `Settings → Secrets and variables → Actions` im Immogent-Repo

### "Migration wird nicht ausgeführt"

→ **KRITISCH:** Ist sie in `drizzle/meta/_journal.json`?

```bash
grep "0008" drizzle/meta/_journal.json
# Muss einen Eintrag mit idx, digest haben
```

### "E2E-Tests schlagen fehl"

→ Sind Test-Fixtures synchron zur neuen Business Logic?
→ Siehe: `docs/implementation-guide.md` → "E2E-Tests und Business Logic"

---

## 📚 Dokumentation zum Nachschlagen

**Im pi-spec-harness Repo:**
- `README.md` — Übersicht
- `AGENTS.md` — Regeln für Agent-Behavior
- `docs/event-driven-workflow.md` — Workflow (user-facing)
- `docs/implementation-guide.md` — ⭐ Fallstricke & Checklisten
- `docs/human-gates.md` — Gate-Details
- `skills/pi-spec-harness/SKILL.md` — Skill Protocol

**Im Immogent Repo:**
- `docs/30-specifications/SPEC-015-...md` — Aktuelle Spec (RUN-006 Ergebnis)
- `README.md` — Projekt-Übersicht
- `.github/workflows/` — GitHub Actions
- `drizzle/meta/_journal.json` — **Alle Migrationen müssen hier sein**

---

## 🎯 Letztes Wort

**RUN-006 ist durch. Das System funktioniert.**

Die wichtigsten Erkenntnisse:
1. **Vollständigkeit zählt:** Alle 5 DB-Komponenten müssen synchron sein, oder Test-Setup schlägt fehl
2. **Explizit statt implizit:** Type-Conversions, nicht auf Driver-Level-Defaults verlassen
3. **CI ist Quelle der Wahrheit:** Lokale Tests != CI-Tests
4. **Fallstricke sind dokumentiert:** `docs/implementation-guide.md` wurde genau dafür geschrieben

**Viel Erfolg mit RUN-007!** 🚀

---

*Generiert: 2026-07-27 | RUN-006 Status: COMPLETE ✅*
