import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { assertHygiene } from "./hygiene.js";
import type { StateStore } from "./state-store.js";
import { SCHEMA_VERSION, type RunState } from "./types.js";

export class StateLoadError extends Error {}

/**
 * Load run-state from disk. Refuses to continue on an unknown schema version
 * or corrupted JSON -- the operator must restore a known-good file or
 * initialize a new run-id, never patch a broken file in place.
 */
export async function loadRunState(path: string): Promise<RunState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new StateLoadError(`cannot read state file '${path}': ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StateLoadError(`state file '${path}' is not valid JSON: ${(err as Error).message}`);
  }

  const state = parsed as Partial<RunState>;
  if (state.schemaVersion !== SCHEMA_VERSION) {
    throw new StateLoadError(
      `state file '${path}' has schema version ${String(state.schemaVersion)}, expected ${SCHEMA_VERSION}`,
    );
  }

  return state as RunState;
}

/**
 * Persist run-state atomically: write to an exclusive temp file, then rename.
 * If either step fails, the previously persisted state remains untouched.
 */
export async function saveRunState(path: string, state: RunState): Promise<void> {
  assertHygiene(state);

  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;

  try {
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, path);
  } catch (err) {
    await rm(tempPath, { force: true });
    throw err;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export class FileStateStore implements StateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<RunState> {
    return loadRunState(this.path);
  }

  async save(state: RunState): Promise<void> {
    await saveRunState(this.path, state);
  }
}
