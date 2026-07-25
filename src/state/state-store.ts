import type { RunState } from "./types.js";

export interface StateStore {
  load(): Promise<RunState>;
  save(state: RunState): Promise<void>;
  /** Present only for stores backed by a single GitHub issue. */
  readonly issueRef?: { repository: string; number: number; url: string };
}
