/**
 * Persistent store for spec-generation dispatch records.
 *
 * Two backends:
 *  - SpecGenIssueStore  — GitHub-issue-backed, durable across runner lifetimes.
 *                         This is the AUTHORITATIVE production store (TAC-02).
 *  - SpecGenFileStore   — local file, used for local development / unit tests.
 *
 * SPEC-014, decision 2 / TAC-02.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { github } from "../github/gh.js";
import { assertHygiene } from "../state/hygiene.js";
import type { SpecDispatchRecord } from "../state/types.js";

// ---------------------------------------------------------------------------
// GitHub-backed issue store (production)
// ---------------------------------------------------------------------------

/** Label on the spec-gen state issue in the target repository. */
export const SPEC_GEN_STATE_ISSUE_LABEL = "harness:spec-gen-state";

const SPEC_GEN_STATE_ISSUE_TITLE_PREFIX = "[harness:spec-gen-state]";
const STATE_BEGIN = "<!-- harness:spec-gen-state:begin -->";
const STATE_END = "<!-- harness:spec-gen-state:end -->";
const STATE_BLOCK = new RegExp(`${STATE_BEGIN}\\s*\`\`\`json\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\`\\s*${STATE_END}`);

/** Schema version for this store format. */
export const SPEC_GEN_STORE_SCHEMA_VERSION = 1 as const;

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

/** Find a record by agent branch name. Pure. */
export function findStoreRecordByBranch(
  store: SpecGenStoreData,
  branch: string,
): SpecDispatchRecord | undefined {
  return store.records.find((r) => r.branch === branch);
}

// ---------------------------------------------------------------------------
// Issue body serialization helpers (used by SpecGenIssueStore)
// ---------------------------------------------------------------------------

/** Render the store as a GitHub issue body with an embedded JSON block. */
export function renderSpecGenStoreBody(data: SpecGenStoreData): string {
  const jsonBlock = ["```json", JSON.stringify(data, null, 2), "```"].join("\n");
  return [
    "## Spec-Generation State (SPEC-014)",
    "",
    "Persistent outbox for spec-generation dispatch records.",
    "Managed by pi-spec-harness. **Do not edit this issue body manually.**",
    "",
    STATE_BEGIN,
    jsonBlock,
    STATE_END,
  ].join("\n");
}

/** Parse the store data from a GitHub issue body. Returns an empty store if no block found. */
export function parseSpecGenStoreFromBody(body: string): SpecGenStoreData {
  const match = STATE_BLOCK.exec(body);
  if (!match) {
    return { schemaVersion: SPEC_GEN_STORE_SCHEMA_VERSION, records: [] };
  }
  const parsed = JSON.parse(match[1]!) as SpecGenStoreData;
  if (parsed.schemaVersion !== SPEC_GEN_STORE_SCHEMA_VERSION) {
    throw new Error(
      `spec-gen issue store: unsupported schema version ${String(parsed.schemaVersion)}`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// SpecGenIssueStore — GitHub-issue-backed, survives runner process termination
// ---------------------------------------------------------------------------

/**
 * Durable spec-gen store backed by a GitHub issue in the target repository.
 *
 * The issue title is `[harness:spec-gen-state] <repository>`.  The canonical
 * JSON is stored in an HTML-comment-delimited block in the issue body, using
 * the same pattern as the run-state issue store.
 *
 * load()  → find issue by title; parse JSON block (empty store if absent).
 * save()  → create the issue on first call; update body on subsequent calls.
 *
 * This is the AUTHORITATIVE store for production use (SPEC-014 TAC-02).
 */
export class SpecGenIssueStore {
  private readonly issueTitle: string;

  constructor(private readonly repository: string) {
    this.issueTitle = `${SPEC_GEN_STATE_ISSUE_TITLE_PREFIX} ${repository}`;
  }

  /** Load the store from the GitHub issue. Returns an empty store if the issue does not exist yet. */
  async load(): Promise<{ data: SpecGenStoreData; issueNumber?: number }> {
    const ref = await github.findIssueByExactTitle(this.repository, this.issueTitle);
    if (!ref) {
      return { data: { schemaVersion: SPEC_GEN_STORE_SCHEMA_VERSION, records: [] } };
    }
    const issue = await github.viewIssue(this.repository, ref.number);
    const data = parseSpecGenStoreFromBody(issue.body);
    return { data, issueNumber: ref.number };
  }

  /**
   * Persist the store to GitHub.  Hygiene-checked before write.
   * If `issueNumber` is provided the existing issue body is updated;
   * otherwise the issue is found-or-created (safe against concurrent first-write).
   */
  async save(data: SpecGenStoreData, issueNumber?: number): Promise<void> {
    assertHygiene(data);
    const body = renderSpecGenStoreBody(data);
    if (issueNumber !== undefined) {
      await github.updateIssueBody(this.repository, issueNumber, body);
      return;
    }
    // Find-or-create: safe against a concurrent first save by re-checking.
    const existing = await github.findIssueByExactTitle(this.repository, this.issueTitle);
    if (existing) {
      await github.updateIssueBody(this.repository, existing.number, body);
    } else {
      await github.createIssue(this.repository, {
        title: this.issueTitle,
        body,
        labels: [SPEC_GEN_STATE_ISSUE_LABEL],
      });
    }
  }
}

// ---------------------------------------------------------------------------
// SpecGenFileStore — local file store (local dev / unit tests)
// ---------------------------------------------------------------------------
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
