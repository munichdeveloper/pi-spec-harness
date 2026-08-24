/**
 * Lightweight persistent store for spec-generation dispatch records.
 * Stored as a flat JSON array keyed by dispatchKey; NOT a full RunState.
 * This file is the authoritative idempotency checkpoint for the
 * requirement-to-spec pipeline. SPEC-014, decision 2 / TAC-02.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { assertHygiene } from "../state/hygiene.js";
import type { SpecDispatchRecord } from "../state/types.js";

/** Schema version for this store format. */
const SPEC_GEN_STORE_SCHEMA_VERSION = 1 as const;

export interface SpecGenStoreData {
  schemaVersion: typeof SPEC_GEN_STORE_SCHEMA_VERSION;
  records: SpecDispatchRecord[];
}

/**
 * Monotonic status ordering — a stale/delayed write may not downgrade a record.
 * `cancelled` is a lateral terminal-failure state, only reachable before `pr-open`.
 * Mirrors SPEC_DISPATCH_STATUS_ORDER in state-machine.ts.
 *
 * Permitted transitions:
 *   prepared → dispatched → pr-open → pr-merged
 *   prepared → cancelled
 *   dispatched → cancelled
 * Forbidden:
 *   pr-open   → cancelled  (PR already exists — must not erase evidence)
 *   pr-merged → *          (terminal success — immutable)
 */
const STATUS_ORDER: Record<SpecDispatchRecord["status"], number> = {
  prepared: 0,
  cancelled: 1,
  dispatched: 1,
  "pr-open": 2,
  "pr-merged": 3,
};

/** Find a record by dispatch key. Pure. */
export function findStoreRecord(
  store: SpecGenStoreData,
  dispatchKey: string,
): SpecDispatchRecord | undefined {
  return store.records.find((r) => r.dispatchKey === dispatchKey);
}

/**
 * Upsert a record into the store. Monotonic: refuses status downgrade.
 * Pure — returns a new SpecGenStoreData value.
 */
export function upsertStoreRecord(
  store: SpecGenStoreData,
  record: SpecDispatchRecord,
): SpecGenStoreData {
  const idx = store.records.findIndex((r) => r.dispatchKey === record.dispatchKey);
  if (idx >= 0) {
    const current = store.records[idx]!;
    if (STATUS_ORDER[record.status] < STATUS_ORDER[current.status]) {
      throw new Error(
        `spec-gen store: refusing status downgrade from '${current.status}' to '${record.status}' for key '${record.dispatchKey}'`,
      );
    }
    const updated = [...store.records];
    updated[idx] = record;
    return { ...store, records: updated };
  }
  return { ...store, records: [...store.records, record] };
}

/** File-backed spec-gen store. */
export class SpecGenFileStore {
  constructor(private readonly path: string) {}

  /** Load the store from disk. Returns an empty store on first use (file absent). */
  async load(): Promise<SpecGenStoreData> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as SpecGenStoreData;
      if (parsed.schemaVersion !== SPEC_GEN_STORE_SCHEMA_VERSION) {
        throw new Error(
          `spec-gen store '${this.path}' has unsupported schema version ${String(parsed.schemaVersion)}`,
        );
      }
      return parsed;
    } catch (err) {
      // File missing or parse error on first run → start fresh.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: SPEC_GEN_STORE_SCHEMA_VERSION, records: [] };
      }
      throw err;
    }
  }

  /** Atomically persist the store. Hygiene-checked before write. */
  async save(store: SpecGenStoreData): Promise<void> {
    assertHygiene(store);
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(tempPath, this.path);
    } catch (err) {
      await rm(tempPath, { force: true });
      throw err;
    }
  }
}
