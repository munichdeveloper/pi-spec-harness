const HARNESS_REPOSITORY = "munichdeveloper/pi-spec-harness";

export interface SyntheticArtifactFixtureContext {
  enabled?: string;
  synthetic?: string;
  repository?: string;
}

/**
 * Produces a deliberately stale copy of a synthetic result artifact.
 * Production evidence validation remains untouched: the hosted controller must
 * reject this copy because its spec revision no longer matches canonical work.
 */
export function prepareSyntheticArtifactFixture<T extends { specRevision: string }>(
  artifact: T,
  context: SyntheticArtifactFixtureContext,
): T {
  if (context.enabled === undefined || context.enabled === "" || context.enabled === "false") {
    return artifact;
  }
  if (
    context.enabled !== "true" ||
    context.synthetic !== "true" ||
    context.repository !== HARNESS_REPOSITORY
  ) {
    throw new Error("Stale artifact fixture requires explicit synthetic Harness activation");
  }
  if (!/^[a-f0-9]{40}$/.test(artifact.specRevision)) {
    throw new Error("Invalid synthetic artifact revision");
  }

  return {
    ...artifact,
    specRevision: artifact.specRevision === "f".repeat(40) ? "e".repeat(40) : "f".repeat(40),
  };
}
