# Implementation Guide für KI-Agenten

Dieses Dokument richtet sich an KI-Agenten (z.B. Copilot), die GitHub Issues implementieren, die vom pi-spec-harness generiert wurden. Es enthält häufige Fallstricke, die bei echtem CI-Durchlauf entdeckt werden, sowie Checklisten.

---

## 🚨 Häufige Fallstricke (Lessons Learned aus RUN-006)

### 1. **Datenbank-Migrationen müssen überall synchron sein**

**Das Problem:** RUN-006 schlug in der CI fehl, weil die neue Migration `0008_offer-evaluation.sql` geschrieben war, aber:

- ❌ Nicht in `drizzle/meta/_journal.json` registriert → wurde beim Test-Setup **überhaupt nicht ausgeführt**
- ❌ Schema in `src/db/schema.ts` nicht aktualisiert
- ❌ `INSERT`-Statements in Repository-Klassen fehlten die neuen Spalten
- ❌ TypeScript-Typen erwarteten alte Spaltenanzahl

**Root Cause:** Lokale Tests liefen nicht mit echtem Datenbankzustand — das wurde erst im CI offensichtlich.

**Checklist für DB-Migrationen:**

```bash
# 1. SQL-Migration schreiben
# 2. Journal registrieren (MUSS SEIN!)
cat drizzle/meta/_journal.json
# ... überprüfe, dass deine neue Migration als Eintrag existiert:
#  { "idx": 8, "version": "5", "digest": "...", "when": ... }

# 3. Schema-Snapshot für diese Migration erstellen
drizzle/meta/0008_snapshot.json
# (Sollte die neue Tabelle mit allen Spalten zeigen)

# 4. src/db/schema.ts aktualisieren
# - Enum-Werte hinzufügen (wenn relevant)
# - Neue Spalten mit expliziten Typen hinzufügen
# - notNull/nullable synchron zur Migration

# 5. INSERT-Statements in allen Repositories überprüfen
# grep -n "INSERT INTO offers" src/infrastructure/*.ts
# Alle neuen Spalten (auch nullable!) sollten in VALUES(...) vorkommen

# 6. SELECT-Statements + Type-Mapping
# - OfferRow Type: neue Felder hinzufügen
# - mapOfferRow(): explizite Konvertierung für timestamp/JSON (nicht auf Driver-Level verlassen!)
# 
#   function toDateOrNull(value: unknown): Date | null {
#     if (value === null || value === undefined) return null;
#     return value instanceof Date ? value : new Date(value as string);
#   }

# 7. Test-Integration mit echtem DB-Setup
npm run test  # Nicht nur Unit-Tests, auch Integration mit DB
```

**Kritisch:** Testen im CI ist anders als lokal. Wenn du `drizzle migrate` lokal aufgerufen hast, ist die Migration im Journal. Aber wenn dich CI neu spiunt, muss das Journal **bereits im Git enthalten sein**.

---

### 2. **Type Conversions müssen explizit sein**

**Das Problem:** `postgres.js` konvertiert Timestamp-Felder nicht immer automatisch zu `Date`, besonders nicht in allen Query-Pfaden.

```typescript
// ❌ FALSCH: Auf Driver-Level-Konvertierung verlassen
evaluatedAt: row.evaluatedAt as Date  // Könnte noch ein String sein!

// ✅ RICHTIG: Explizite Konvertierung im Mapper
evaluatedAt: row.evaluatedAt instanceof Date 
  ? row.evaluatedAt 
  : row.evaluatedAt ? new Date(row.evaluatedAt as string) : null
```

**Warum:** Abhängig vom Query-Pfad (direkt vs. durch ORM), kann der DB-Treiber unterschiedliche Typen zurückgeben.

---

### 3. **E2E-Tests und Business Logic**

**Das Problem:** E2E-Tests schreiben oft Daten, die unter alte Geschäftslogik passten, aber unter neuer Logik korrekt herausgefiltert werden.

**Beispiel:** Ein Angebot mit `locality: "München"` (ohne Postleitzahl) an ein Profil mit `location: { type: "postal_code", value: "80331" }` gesendet. Vorher: unsichtbar, aber in DB. Nachher: korrekt als `evaluation_status: "excluded"` markiert → unsichtbar, auch korrekt.

**Unterschied:**
- **Alte Tests:** Annahmen, dass der Offer vorhanden ist (egal ob gefiltert)
- **Mit neuer Bewertungslogik:** Filter ist aktiv → Offer ist unsichtbar

**Lösungsansätze (in Priorität):**

1. **Test-Daten reparieren** (bevorzugt):
   - `locality: "München"` → `locality: "80331 München"` (Postleitzahl matchet jetzt)
   - Liefert korrekte Evaluation `interesting`, alles funktioniert wie vorher

2. **Filter-Parameter anpassen:**
   ```javascript
   // Wenn Reparatur nicht möglich (z.B. bewusst Transaktionstyp-Mismatch testen):
   await page.goto(`${profileUrl}?filter=all`);  // Bypass evaluation filter
   // Test prüft jetzt das Parsing, nicht die Bewertungslogik
   ```

3. **Test-Assertion aktualisieren:**
   ```javascript
   // Wenn das Angebot korrekt excluded sein soll:
   await expect(page.getByText(title)).not.toBeVisible();
   // oder
   await page.goto(`${profileUrl}?filter=excluded`);
   await expect(page.getByText(title)).toBeVisible();
   ```

---

## ✅ Implementation Checklist

### Phase 1: Design & Spec (vor Implementation)

- [ ] Alle neuen Features/Spalten in SPEC klar dokumentiert
- [ ] Wenn DB-Change: Migration-Nummer und -inhalt in SPEC skizziert
- [ ] Akzeptanzkriterien adressieren alle Branches (Happy Path + Error Cases)

### Phase 2: Implementation

#### Code

- [ ] Feature-Branch erstellt: `agent/issue-XXX-name`
- [ ] Alle Akzeptanzkriterien adressiert
- [ ] Kein `any` in TypeScript (bei echtem Check)

#### Datenbank (falls relevant)

- [ ] SQL-Migration geschrieben: `drizzle/000X_*.sql`
- [ ] **Journal aktualisiert** (`drizzle/meta/_journal.json`)
- [ ] **Snapshot erstellt** (`drizzle/meta/000X_snapshot.json`)
- [ ] `src/db/schema.ts` synchron zur Migration
- [ ] Alle `INSERT`-Statements neue Spalten enthalten (auch nullable)
- [ ] `SELECT`-Statements + Type-Mapping überprüft
  - [ ] OfferRow Type ergänzt
  - [ ] Mapper mit expliziter Konvertierung (Timestamps, JSON)

#### Tests

- [ ] Unit-Tests für neue Logik (isoliert, keine DB)
- [ ] Integration-Tests mit echtem DB-Setup
- [ ] E2E-Tests:
  - [ ] Test-Fixtures passen zu neuer Geschäftslogik
  - [ ] Falls Mismatch unvermeidbar: `filter=` Parameter oder neue Assertions
  - [ ] Keine `test.skip` ohne guten Grund (Production-Only ist OK)

### Phase 3: Code Review (manuell oder Harness)

- [ ] Migrationen überprüfen: Journal + Snapshot + Schema
- [ ] Type-Safety überprüft (kein unsicheres `as` für DB-Felder)
- [ ] E2E-Fehler verstanden (nicht nur "Retry-Button drücken")

---

## 📝 Schnelle Diagnose bei CI-Fehlern

### "Constraint violation" oder "column does not exist"

→ Migration wurde nicht ausgeführt
- [ ] Ist die Migration in `drizzle/meta/_journal.json`?
- [ ] Hat sie einen eindeutigen Digest/Hash?
- [ ] Wurde die Datei zu Git hinzugefügt?

### "Type mismatch" oder "cannot convert X to Date"

→ Explizite Konvertierung fehlt
- [ ] Checke `mapOfferRow()` und ähnliche Mapper
- [ ] Besonders: Timestamp-Felder mit `null` möglich?

### "Element not found" in E2E

→ Likely Geschäftslogik-Change, nicht Code-Bug
- [ ] Wurde der Offer korrekt bewertet?
- [ ] Passt die Evaluation zum Test-Fixture?
- [ ] Sollte `?filter=` Parameter verwendet werden?

---

## 🔗 Weiterführende Dokumentation

- [`docs/event-driven-workflow.md`](event-driven-workflow.md) – Harness-Workflow von außen
- [`../AGENTS.md`](../AGENTS.md) – Regeln für Agenten im Harness selbst
- RUN-006 Logs: GitHub Actions → `Run Browser E2E` Step

