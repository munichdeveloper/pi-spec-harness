import { github } from "../github/gh.js";

/** Explicit notification avoids relying on GITHUB_TOKEN workflow_run cascades. */
export async function notifyReadinessCompletion(
  env: NodeJS.ProcessEnv = process.env,
  api: Pick<typeof github, "notifyReadinessReconciliation"> = github,
): Promise<void> {
  if (env.GITHUB_ACTIONS !== "true" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(env.GITHUB_REPOSITORY ?? "") ||
      !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "")) {
    throw new Error("Readiness notification requires a same-repository Actions execution");
  }
  await api.notifyReadinessReconciliation(env.GITHUB_REPOSITORY!, env.GITHUB_RUN_ID!);
}
