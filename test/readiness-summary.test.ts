import { describe, expect, it } from "vitest";
import { renderStateBody, parseStateFromBody } from "../src/state/issue-store.js";
import { initRunState } from "../src/state/state-machine.js";

describe("readiness execution summary", () => {
  it.each([
    ["completed", "Ausführung abgeschlossen; Ausgabe gespeichert"],
    ["failed", "Ausführung fehlgeschlagen; Klärung erforderlich"],
    ["claimed", "Ausführung begonnen"],
  ] as const)("renders %s without claiming overall completion", (status, text) => {
    const state = initRunState({ repository: "acme/product", runId: "test", requirement: "REQ-001", spec: "SPEC-001" });
    state.readiness = { schemaVersion: 1, revision: "revision", work: [{
      key: "work", revision: "revision", kind: "implementation", executorId: "test", attempt: 1,
      receipt: "github-actions:123", execution: { receipt: "github-actions:123", status, startedAt: "now" },
    }] };
    const body = renderStateBody(state);
    expect(body).toContain(text);
    expect(body).not.toContain("gesendet; Ergebnis ausstehend");
    expect(parseStateFromBody(body)).toEqual(state);
  });
});
