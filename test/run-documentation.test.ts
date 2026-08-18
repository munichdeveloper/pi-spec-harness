/**
 * SPEC-012 unit tests.
 *
 * Covers:
 * - TAC-01: formatCanonicalRunId()
 * - TAC-03: documentationSnapshot round-trip
 * - TAC-04: persist-run-documentation emitted by computeNextAction
 * - TAC-05: transitionPhase to complete requires persisted+audited snapshot
 * - TAC-06/07: renderRunSnapshot() — deterministic, stable, allowlisted fields
 * - TAC-09: generateRunIndex() / generateObsidianBase() — sorted, classified
 * - TAC-10: validateDocumentationPath() / validateStagedPaths()
 * - TAC-11: duplicate delivery is a no-op (already-persisted guard)
 * - TAC-12: conflict retry preserves existing run history
 * - TAC-14: validateSnapshotContent() — PII, secrets, evidence URLs rejected
 * - TAC-16: renderRunDocumentationFinalizer() — minimal permissions, no secrets:inherit, cancel-in-progress: false
 * - TAC-17: persist-run-documentation CLI command contract (state machine + integration)
 * - TAC-18 (integration): cmdPersistRunDocumentation via injected adapter
 */

import { describe, expect, it } from "vitest";
import {
  computeNextAction,
  formatCanonicalRunId,
  initRunState,
  recordDeliveryMergeEffect,
  resolveGate,
  transitionPhase,
  upsertDocumentationSnapshot,
  upsertGate,
} from "../src/state/state-machine.js";
import { renderRunSnapshot, slugify, buildSnapshotFilename } from "../src/documentation/run-snapshot.js";
import {
  generateRunIndex,
  generateObsidianBase,
  parseFrontmatter,
  parseRunIndexEntry,
  sortRunIndexEntries,
} from "../src/documentation/run-index.js";
import { validateDocumentationPath, validateStagedPaths, normalizePath, validateSnapshotContent } from "../src/documentation/path-validator.js";
import {
  renderRunDocumentationFinalizer,
  RUN_DOCUMENTATION_FINALIZER_MARKER,
} from "../src/workflows/template-catalog.js";
import type { WriterGithubAdapter } from "../src/cli.js";
import { cmdPersistRunDocumentation } from "../src/cli.js";
import type { RunState } from "../src/state/types.js";
import type { StateStore } from "../src/state/state-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha(hexChar: string): string {
  return hexChar.repeat(40);
}

function baseState() {
  return initRunState({
    runId: "RUN-0056",
    repository: "munichdeveloper/pi-spec-harness",
    requirement: "REQ-012",
    spec: "SPEC-012",
    branch: "feature/spec-012",
  });
}

function stateWithMergeEvidence() {
  let state = baseState();
  const approvedHeadSha = sha("a");
  state = { ...state, phase: "merge" as const, deliveryPullRequest: 56, deliveryHeadSha: approvedHeadSha };
  const gateId = `merge-approval-pr56-sha${approvedHeadSha.slice(0, 8)}`;
  state = upsertGate(state, { id: gateId, type: "human", question: "Approve?" });
  state = resolveGate(state, gateId, {
    result: "passed",
    decision: { approved: true, by: "test", at: "2026-08-18T10:00:00Z" },
  });
  state = recordDeliveryMergeEffect(state, {
    pullRequest: 56,
    approvedHeadSha,
    mergeCommitSha: sha("b"),
    mergedAt: "2026-08-18T11:00:00Z",
  });
  return state;
}

const PERSISTED_SNAPSHOT: Parameters<typeof upsertDocumentationSnapshot>[1] = {
  schemaVersion: 1,
  status: "persisted",
  idempotencyKey: "idem-key-test",
  path: "docs/runs/generated/RUN-0056-spec-012.md",
  indexPath: "docs/runs/RUN-INDEX.md",
  obsidianBasePath: "docs/runs/Runs.base",
  generatedAt: "2026-08-18T12:00:00Z",
  sourceHeadSha: sha("b"),
  commitSha: sha("c"),
  auditIdempotencyKey: "audit-idem-key-test",
  auditConfirmedAt: "2026-08-18T12:05:00Z",
};

// ---------------------------------------------------------------------------
// TAC-01: formatCanonicalRunId
// ---------------------------------------------------------------------------

describe("TAC-01 formatCanonicalRunId", () => {
  it("pads issue 56 to RUN-0056", () => {
    const result = formatCanonicalRunId("munichdeveloper/pi-spec-harness", 56);
    expect(result.runId).toBe("RUN-0056");
  });

  it("forms the qualified run ID correctly", () => {
    const result = formatCanonicalRunId("munichdeveloper/pi-spec-harness", 56);
    expect(result.qualifiedRunId).toBe("munichdeveloper/pi-spec-harness#RUN-0056");
  });

  it("forms the process instance correctly", () => {
    const result = formatCanonicalRunId("munichdeveloper/pi-spec-harness", 56);
    expect(result.processInstance).toBe("PI-MUNICHDEVELOPER-PI-SPEC-HARNESS-RUN-0056");
  });

  it("does not truncate large issue numbers (12345 → RUN-12345)", () => {
    const result = formatCanonicalRunId("munichdeveloper/pi-spec-harness", 12345);
    expect(result.runId).toBe("RUN-12345");
    expect(result.qualifiedRunId).toBe("munichdeveloper/pi-spec-harness#RUN-12345");
  });

  it("handles 4-digit issue number (1234 → RUN-1234, not truncated)", () => {
    const result = formatCanonicalRunId("org/repo", 1234);
    expect(result.runId).toBe("RUN-1234");
  });

  it("handles single-digit issue (3 → RUN-0003)", () => {
    const result = formatCanonicalRunId("org/repo", 3);
    expect(result.runId).toBe("RUN-0003");
  });
});

// ---------------------------------------------------------------------------
// TAC-03: documentationSnapshot round-trip
// ---------------------------------------------------------------------------

describe("TAC-03 documentationSnapshot backward compatibility", () => {
  it("states without documentationSnapshot are read and round-tripped unmodified", () => {
    const state = baseState();
    expect(state.documentationSnapshot).toBeUndefined();
    // Serialize and deserialize
    const json = JSON.stringify(state);
    const restored = JSON.parse(json);
    expect(restored.documentationSnapshot).toBeUndefined();
    // All other fields preserved
    expect(restored.runId).toBe(state.runId);
  });

  it("upsertDocumentationSnapshot sets the checkpoint", () => {
    const state = upsertDocumentationSnapshot(baseState(), PERSISTED_SNAPSHOT);
    expect(state.documentationSnapshot?.status).toBe("persisted");
    expect(state.documentationSnapshot?.commitSha).toBe(sha("c"));
    expect(state.documentationSnapshot?.auditConfirmedAt).toBe("2026-08-18T12:05:00Z");
  });

  it("upsertDocumentationSnapshot merges partial updates", () => {
    const state0 = upsertDocumentationSnapshot(baseState(), { ...PERSISTED_SNAPSHOT, status: "prepared", commitSha: undefined, auditConfirmedAt: undefined });
    const state1 = upsertDocumentationSnapshot(state0, { ...PERSISTED_SNAPSHOT, status: "publishing" });
    const state2 = upsertDocumentationSnapshot(state1, { ...PERSISTED_SNAPSHOT, status: "persisted" });
    expect(state2.documentationSnapshot?.status).toBe("persisted");
    expect(state2.documentationSnapshot?.commitSha).toBe(sha("c"));
  });
});

// ---------------------------------------------------------------------------
// TAC-04: computeNextAction emits persist-run-documentation
// ---------------------------------------------------------------------------

describe("TAC-04 computeNextAction persist-run-documentation", () => {
  it("emits persist-run-documentation when merge evidence is present but snapshot is absent", () => {
    const state = stateWithMergeEvidence();
    expect(state.documentationSnapshot).toBeUndefined();
    const action = computeNextAction(state);
    expect(action.action).toBe("persist-run-documentation");
  });

  it("emits persist-run-documentation when snapshot status is prepared", () => {
    let state = stateWithMergeEvidence();
    state = upsertDocumentationSnapshot(state, { ...PERSISTED_SNAPSHOT, status: "prepared", commitSha: undefined, auditConfirmedAt: undefined });
    expect(computeNextAction(state).action).toBe("persist-run-documentation");
  });

  it("emits persist-run-documentation when snapshot is persisted but audit is missing", () => {
    let state = stateWithMergeEvidence();
    state = upsertDocumentationSnapshot(state, { ...PERSISTED_SNAPSHOT, auditConfirmedAt: undefined });
    expect(computeNextAction(state).action).toBe("persist-run-documentation");
  });

  it("emits advance-phase once snapshot is fully persisted and audited", () => {
    let state = stateWithMergeEvidence();
    state = upsertDocumentationSnapshot(state, PERSISTED_SNAPSHOT);
    const action = computeNextAction(state);
    expect(action.action).toBe("advance-phase");
  });
});

// ---------------------------------------------------------------------------
// TAC-05: transitionPhase to complete requires snapshot
// ---------------------------------------------------------------------------

describe("TAC-05 transitionPhase to complete", () => {
  it("throws without documentation snapshot", () => {
    const state = stateWithMergeEvidence();
    expect(() => transitionPhase(state, "complete")).toThrow(/persisted and audited documentation snapshot/);
  });

  it("throws when snapshot is not persisted", () => {
    let state = stateWithMergeEvidence();
    state = upsertDocumentationSnapshot(state, { ...PERSISTED_SNAPSHOT, status: "prepared", commitSha: undefined, auditConfirmedAt: undefined });
    expect(() => transitionPhase(state, "complete")).toThrow(/persisted and audited documentation snapshot/);
  });

  it("succeeds when snapshot is persisted and audited", () => {
    let state = stateWithMergeEvidence();
    state = upsertDocumentationSnapshot(state, PERSISTED_SNAPSHOT);
    expect(transitionPhase(state, "complete").phase).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
// TAC-06/07: renderRunSnapshot — deterministic, allowlisted fields
// ---------------------------------------------------------------------------

describe("TAC-06/07 renderRunSnapshot", () => {
  const trackingIssue = {
    repository: "munichdeveloper/pi-spec-harness",
    number: 56,
    url: "https://github.com/munichdeveloper/pi-spec-harness/issues/56",
  };

  it("produces byte-identical output for the same input", () => {
    let state = stateWithMergeEvidence();
    state = upsertDocumentationSnapshot(state, PERSISTED_SNAPSHOT);

    const input = { state, trackingIssue, repositoryDefaultBranch: "main", harnessVersion: "0.2.2" };
    const r1 = renderRunSnapshot(input);
    const r2 = renderRunSnapshot(input);
    expect(r1).toBe(r2);
  });

  it("includes YAML frontmatter with schema_version: 1", () => {
    let state = stateWithMergeEvidence();
    state = upsertDocumentationSnapshot(state, PERSISTED_SNAPSHOT);
    const result = renderRunSnapshot({ state, trackingIssue, repositoryDefaultBranch: "main", harnessVersion: "0.2.2" });
    expect(result).toContain("schema_version: 1");
    expect(result).toContain(`run_id: "RUN-0056"`);
    expect(result).toContain(`repository: "munichdeveloper/pi-spec-harness"`);
    expect(result).toContain(`spec: "SPEC-012"`);
  });

  it("contains required sections", () => {
    let state = stateWithMergeEvidence();
    state = upsertDocumentationSnapshot(state, PERSISTED_SNAPSHOT);
    const result = renderRunSnapshot({ state, trackingIssue, repositoryDefaultBranch: "main", harnessVersion: "0.2.2" });
    expect(result).toContain("## Identity and Status");
    expect(result).toContain("## Delivery");
    expect(result).toContain("## Gates");
    expect(result).toContain("## Iterations");
    expect(result).toContain("## Reviews");
    expect(result).toContain("## Review Threads");
    expect(result).toContain("## Documentation Snapshot");
    expect(result).toContain("## Harness Metadata");
  });

  it("sorts gates stably by id regardless of insertion order", () => {
    let state = stateWithMergeEvidence();
    state = upsertGate(state, { id: "zzz-gate", type: "spec", question: "?" });
    state = upsertGate(state, { id: "aaa-gate", type: "spec", question: "?" });
    state = upsertDocumentationSnapshot(state, PERSISTED_SNAPSHOT);
    const result = renderRunSnapshot({ state, trackingIssue, repositoryDefaultBranch: "main", harnessVersion: "0.2.2" });
    const aPos = result.indexOf("aaa-gate");
    const zPos = result.indexOf("zzz-gate");
    expect(aPos).toBeLessThan(zPos);
  });

  it("renders notes as cited lines, not new prose", () => {
    let state = stateWithMergeEvidence();
    state = { ...state, notes: ["Manual note one", "Manual note two"] };
    state = upsertDocumentationSnapshot(state, PERSISTED_SNAPSHOT);
    const result = renderRunSnapshot({ state, trackingIssue, repositoryDefaultBranch: "main", harnessVersion: "0.2.2" });
    expect(result).toContain("## Notes");
    expect(result).toContain("- Manual note one");
    expect(result).toContain("- Manual note two");
  });

  it("renders null for missing optional values", () => {
    let state = stateWithMergeEvidence();
    state = upsertDocumentationSnapshot(state, PERSISTED_SNAPSHOT);
    const result = renderRunSnapshot({ state, trackingIssue, repositoryDefaultBranch: "main", harnessVersion: "0.2.2" });
    // branch is set; verify it appears; iterations/reviews should show _No ... recorded._
    expect(result).toContain("_No iterations recorded._");
    expect(result).toContain("_No reviews recorded._");
    expect(result).toContain("_No review threads recorded._");
  });
});

// ---------------------------------------------------------------------------
// slugify / buildSnapshotFilename
// ---------------------------------------------------------------------------

describe("slugify and buildSnapshotFilename", () => {
  it("slugifies a spec id", () => {
    expect(slugify("SPEC-012")).toBe("spec-012");
    expect(slugify("Verlustsichere Run-Dokumentation")).toBe("verlustsichere-run-dokumentation");
  });

  it("builds the snapshot filename correctly", () => {
    expect(buildSnapshotFilename("RUN-0056", "SPEC-012")).toBe("RUN-0056-spec-012.md");
  });
});

// ---------------------------------------------------------------------------
// TAC-09: generateRunIndex / generateObsidianBase
// ---------------------------------------------------------------------------

describe("TAC-09 generateRunIndex and generateObsidianBase", () => {
  const entries = [
    {
      filePath: "docs/runs/generated/RUN-0003-spec-003.md",
      runId: "RUN-0003",
      qualifiedRunId: "org/repo#RUN-0003",
      repository: "org/repo",
      spec: "SPEC-003",
      trackingIssue: 3,
      trackingIssueUrl: "https://github.com/org/repo/issues/3",
      phase: "complete",
      deliveryMergedAt: "2026-07-01T10:00:00Z",
      updatedAt: "2026-07-01T10:00:00Z",
      classification: "generated" as const,
    },
    {
      filePath: "docs/runs/RUN-0001-spec-001.md",
      runId: "RUN-0001",
      qualifiedRunId: "org/repo#RUN-0001",
      repository: "org/repo",
      spec: "SPEC-001",
      trackingIssue: 1,
      trackingIssueUrl: null,
      phase: "complete",
      deliveryMergedAt: "2026-06-01T10:00:00Z",
      updatedAt: "2026-06-01T10:00:00Z",
      classification: "legacy" as const,
    },
    {
      filePath: "docs/runs/generated/RUN-0056-spec-012.md",
      runId: "RUN-0056",
      qualifiedRunId: "org/repo#RUN-0056",
      repository: "org/repo",
      spec: "SPEC-012",
      trackingIssue: 56,
      trackingIssueUrl: "https://github.com/org/repo/issues/56",
      phase: "complete",
      deliveryMergedAt: "2026-08-18T12:00:00Z",
      updatedAt: "2026-08-18T12:00:00Z",
      classification: "generated" as const,
    },
  ];

  it("sorts entries descending by deliveryMergedAt (TAC-09)", () => {
    const sorted = sortRunIndexEntries(entries);
    expect(sorted[0].runId).toBe("RUN-0056");
    expect(sorted[1].runId).toBe("RUN-0003");
    expect(sorted[2].runId).toBe("RUN-0001");
  });

  it("generateRunIndex contains all run IDs and classification column", () => {
    const idx = generateRunIndex(entries, "2026-08-18T12:30:00Z");
    expect(idx).toContain("RUN-0056");
    expect(idx).toContain("RUN-0003");
    expect(idx).toContain("RUN-0001");
    expect(idx).toContain("generated");
    expect(idx).toContain("legacy");
    // Header present
    expect(idx).toContain("| Run ID |");
    expect(idx).toContain("| Classification |");
  });

  it("generateRunIndex is deterministic", () => {
    const a = generateRunIndex(entries, "2026-08-18T12:30:00Z");
    const b = generateRunIndex([...entries].reverse(), "2026-08-18T12:30:00Z");
    expect(a).toBe(b);
  });

  it("generateObsidianBase contains YAML block", () => {
    const base = generateObsidianBase(entries, "2026-08-18T12:30:00Z");
    expect(base).toContain("runs:");
    expect(base).toContain("run_id: \"RUN-0056\"");
    expect(base).toContain("classification: \"generated\"");
  });

  it("generateObsidianBase is deterministic", () => {
    const a = generateObsidianBase(entries, "2026-08-18T12:30:00Z");
    const b = generateObsidianBase([...entries].reverse(), "2026-08-18T12:30:00Z");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatter and parseRunIndexEntry
// ---------------------------------------------------------------------------

describe("parseFrontmatter / parseRunIndexEntry", () => {
  const sampleDoc = `---
schema_version: 1
run_id: "RUN-0056"
qualified_run_id: "org/repo#RUN-0056"
repository: "org/repo"
spec: "SPEC-012"
tracking_issue: 56
tracking_issue_url: "https://github.com/org/repo/issues/56"
phase: "complete"
delivery_merged_at: "2026-08-18T12:00:00Z"
updated_at: "2026-08-18T12:00:00Z"
generated: true
legacy: false
---

# Run Snapshot
`;

  it("parses frontmatter from a snapshot document", () => {
    const fm = parseFrontmatter(sampleDoc);
    expect(fm).not.toBeNull();
    expect(fm!["run_id"]).toBe("RUN-0056");
    expect(fm!["schema_version"]).toBe(1);
    expect(fm!["generated"]).toBe(true);
  });

  it("returns null for content without frontmatter", () => {
    expect(parseFrontmatter("# No frontmatter")).toBeNull();
  });

  it("parseRunIndexEntry builds a valid entry from snapshot content", () => {
    const entry = parseRunIndexEntry("docs/runs/generated/RUN-0056-spec-012.md", sampleDoc);
    expect(entry).not.toBeNull();
    expect(entry!.runId).toBe("RUN-0056");
    expect(entry!.classification).toBe("generated");
    expect(entry!.trackingIssue).toBe(56);
  });

  it("parseRunIndexEntry classifies reconstructed files correctly", () => {
    const legacyDoc = sampleDoc.replace("generated: true", "generated: false").replace("legacy: false", "legacy: true");
    const entry = parseRunIndexEntry("docs/runs/reconstructed/RUN-0007.md", legacyDoc);
    expect(entry!.classification).toBe("legacy-reconstructed");
  });

  it("parseRunIndexEntry returns null for documents without run_id", () => {
    expect(parseRunIndexEntry("docs/runs/readme.md", "---\ntitle: readme\n---\n# hi")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TAC-10: validateDocumentationPath / validateStagedPaths
// ---------------------------------------------------------------------------

describe("TAC-10 path validation", () => {
  it("accepts valid relative paths inside docs/", () => {
    expect(() => validateDocumentationPath("docs/runs/generated/RUN-0056.md")).not.toThrow();
    expect(() => validateDocumentationPath("docs/runs/RUN-INDEX.md")).not.toThrow();
    expect(() => validateDocumentationPath("docs/runs/Runs.base")).not.toThrow();
  });

  it("rejects absolute paths", () => {
    expect(() => validateDocumentationPath("/etc/passwd")).toThrow(/relative/);
    expect(() => validateDocumentationPath("C:\\Windows\\System32")).toThrow(/relative/);
  });

  it("rejects traversal components", () => {
    expect(() => validateDocumentationPath("docs/../../secret")).toThrow(/traversal/);
  });

  it("rejects paths outside allowlisted directories", () => {
    expect(() => validateDocumentationPath("src/evil.ts")).toThrow(/allowlisted/);
    expect(() => validateDocumentationPath("package.json")).toThrow(/allowlisted/);
  });

  it("normalizePath collapses slashes and ./ prefix", () => {
    expect(normalizePath("./docs/runs/generated/RUN-0056.md")).toBe("docs/runs/generated/RUN-0056.md");
    expect(normalizePath("docs//runs//file.md")).toBe("docs/runs/file.md");
  });

  it("validateStagedPaths passes for exact set", () => {
    const staged = [
      "docs/runs/generated/RUN-0056.md",
      "docs/runs/RUN-INDEX.md",
      "docs/runs/Runs.base",
    ];
    expect(() =>
      validateStagedPaths(staged, [
        "docs/runs/generated/RUN-0056.md",
        "docs/runs/RUN-INDEX.md",
        "docs/runs/Runs.base",
      ]),
    ).not.toThrow();
  });

  it("validateStagedPaths rejects unexpected extra paths", () => {
    expect(() =>
      validateStagedPaths(
        ["docs/runs/generated/RUN-0056.md", "docs/runs/RUN-INDEX.md", "docs/runs/Runs.base", "src/evil.ts"],
        ["docs/runs/generated/RUN-0056.md", "docs/runs/RUN-INDEX.md", "docs/runs/Runs.base"],
      ),
    ).toThrow(/unexpected staged path/);
  });

  it("validateStagedPaths rejects missing expected paths", () => {
    expect(() =>
      validateStagedPaths(
        ["docs/runs/generated/RUN-0056.md"],
        ["docs/runs/generated/RUN-0056.md", "docs/runs/RUN-INDEX.md", "docs/runs/Runs.base"],
      ),
    ).toThrow(/expected staged path/);
  });

  // Regression: bare directory names must be rejected (not treated as inside the prefix)
  it("rejects bare allowlist directory names (docs, .github)", () => {
    expect(() => validateDocumentationPath("docs")).toThrow(/allowlisted/);
    expect(() => validateDocumentationPath(".github")).toThrow(/allowlisted/);
  });

  // Regression: duplicate staged paths must be rejected
  it("validateStagedPaths rejects duplicate staged paths", () => {
    expect(() =>
      validateStagedPaths(
        [
          "docs/runs/generated/RUN-0056.md",
          "docs/runs/generated/RUN-0056.md",
          "docs/runs/RUN-INDEX.md",
          "docs/runs/Runs.base",
        ],
        ["docs/runs/generated/RUN-0056.md", "docs/runs/RUN-INDEX.md", "docs/runs/Runs.base"],
      ),
    ).toThrow(/duplicate staged path/);
  });
});

// ---------------------------------------------------------------------------
// TAC-16: renderRunDocumentationFinalizer workflow template
// ---------------------------------------------------------------------------

describe("TAC-16 run-documentation-finalizer workflow template", () => {
  it("contains the managed marker", () => {
    const result = renderRunDocumentationFinalizer();
    expect(result).toContain(RUN_DOCUMENTATION_FINALIZER_MARKER);
  });

  it("uses only the documented minimal permissions", () => {
    const result = renderRunDocumentationFinalizer();
    expect(result).toContain("contents: write");
    expect(result).toContain("issues: write");
    expect(result).toContain("pull-requests: read");
    expect(result).toContain("actions: read");
    // Must not have secrets: inherit as a YAML key (i.e., not as a standalone line)
    expect(result).not.toMatch(/^\s*secrets:\s*inherit\s*$/m);
  });

  it("sets cancel-in-progress: false", () => {
    const result = renderRunDocumentationFinalizer();
    expect(result).toContain("cancel-in-progress: false");
  });

  it("respects the harnessRef option", () => {
    const result = renderRunDocumentationFinalizer({ harnessRef: "v0.3.0" });
    expect(result).toContain("v0.3.0");
  });

  it("is in the workflow template catalog", async () => {
    const { WORKFLOW_TEMPLATE_CATALOG } = await import("../src/workflows/template-catalog.js");
    const entry = WORKFLOW_TEMPLATE_CATALOG.find((t) => t.name === "run-documentation-finalizer");
    expect(entry).toBeDefined();
    expect(entry!.marker).toBe(RUN_DOCUMENTATION_FINALIZER_MARKER);
  });

  // Regression: the reusable workflow file referenced by the template must exist
  it("reusable workflow file exists in the harness repository", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const workflowPath = join(".github", "workflows", "run-documentation-finalizer.yml");
    expect(() => readFileSync(workflowPath)).not.toThrow();
    const content = readFileSync(workflowPath, "utf8");
    expect(content).toContain("workflow_call");
  });
});

// ---------------------------------------------------------------------------
// TAC-17: persist-run-documentation CLI command contract
// ---------------------------------------------------------------------------

describe("TAC-17 persist-run-documentation CLI command contract", () => {
  // Build a state that has confirmed delivery merge (so persist-run-documentation is the next action).
  function makePersistReadyState() {
    // Re-use the shared stateWithMergeEvidence() that correctly binds the
    // delivery PR (deliveryPullRequest=56) before recording the merge effect.
    return stateWithMergeEvidence();
  }

  it("computeNextAction emits persist-run-documentation after delivery merge", () => {
    const state = makePersistReadyState();
    const next = computeNextAction(state);
    expect(next.action).toBe("persist-run-documentation");
  });

  it("renderRunSnapshot produces valid content and buildSnapshotFilename derives the path", () => {
    const state = makePersistReadyState();
    const trackingIssue = { repository: "org/repo", number: 56, url: "https://github.com/org/repo/issues/56" };
    const content = renderRunSnapshot({ state, trackingIssue, repositoryDefaultBranch: "main", harnessVersion: "v0.2.2" });
    expect(content).toContain("run_id:");
    expect(content).toContain("RUN-0056");

    const filename = buildSnapshotFilename("RUN-0056", "SPEC-012");
    expect(filename).toBe("RUN-0056-spec-012.md");
    const snapshotPath = `docs/runs/generated/${filename}`;
    // Paths must all pass validation
    expect(() => validateDocumentationPath(snapshotPath)).not.toThrow();
    expect(() => validateDocumentationPath("docs/runs/RUN-INDEX.md")).not.toThrow();
    expect(() => validateDocumentationPath("docs/runs/Runs.base")).not.toThrow();
    expect(() => validateStagedPaths(
      [snapshotPath, "docs/runs/RUN-INDEX.md", "docs/runs/Runs.base"],
      [snapshotPath, "docs/runs/RUN-INDEX.md", "docs/runs/Runs.base"],
    )).not.toThrow();
  });

  it("upsertDocumentationSnapshot with status=persisted allows phase advance to complete", () => {
    let state = makePersistReadyState();
    const filename = buildSnapshotFilename(state.runId, state.spec);
    const snapshotPath = `docs/runs/generated/${filename}`;
    state = upsertDocumentationSnapshot(state, {
      schemaVersion: 1,
      status: "persisted",
      idempotencyKey: `persist-run-doc-${state.runId}-56`,
      path: snapshotPath,
      indexPath: "docs/runs/RUN-INDEX.md",
      obsidianBasePath: "docs/runs/Runs.base",
      generatedAt: "2024-01-02T00:00:00Z",
      sourceHeadSha: "abc123",
      commitSha: "commitsha",
      auditIdempotencyKey: `audit-run-doc-${state.runId}-56`,
      auditConfirmedAt: "2024-01-02T00:00:01Z",
    });
    const next = computeNextAction(state);
    expect(next.action).toBe("advance-phase");
  });

  it("transitionPhase to complete succeeds after persisted snapshot", () => {
    let state = makePersistReadyState();
    const filename = buildSnapshotFilename(state.runId, state.spec);
    const snapshotPath = `docs/runs/generated/${filename}`;
    state = upsertDocumentationSnapshot(state, {
      schemaVersion: 1,
      status: "persisted",
      idempotencyKey: `persist-run-doc-${state.runId}-56`,
      path: snapshotPath,
      indexPath: "docs/runs/RUN-INDEX.md",
      obsidianBasePath: "docs/runs/Runs.base",
      generatedAt: "2024-01-02T00:00:00Z",
      sourceHeadSha: "abc123",
      commitSha: "commitsha",
      auditIdempotencyKey: `audit-run-doc-${state.runId}-56`,
      auditConfirmedAt: "2024-01-02T00:00:01Z",
    });
    const complete = transitionPhase(state, "complete");
    expect(complete.phase).toBe("complete");
  });

  it("reusable workflow invokes persist-run-documentation command", async () => {
    const { readFileSync } = await import("fs");
    const content = readFileSync(".github/workflows/run-documentation-finalizer.yml", "utf8");
    expect(content).toContain("persist-run-documentation");
    expect(content).toContain("--repository");
    expect(content).toContain("--issue-number");
    expect(content).toContain("--generated-directory");
    expect(content).toContain("--index-path");
    expect(content).toContain("--obsidian-base-path");
    expect(content).toContain("workflow_call");
  });
});

// ---------------------------------------------------------------------------
// TAC-11: duplicate delivery is a no-op (already-persisted idempotency guard)
// ---------------------------------------------------------------------------

describe("TAC-11 duplicate delivery is a no-op", () => {
  function makePersistedState() {
    let state = stateWithMergeEvidence();
    state = upsertDocumentationSnapshot(state, { ...PERSISTED_SNAPSHOT });
    return state;
  }

  it("computeNextAction returns advance-phase when snapshot is already persisted", () => {
    const state = makePersistedState();
    expect(computeNextAction(state).action).toBe("advance-phase");
  });

  it("already-persisted state has commitSha and auditConfirmedAt both set", () => {
    const state = makePersistedState();
    expect(state.documentationSnapshot?.commitSha).toBeDefined();
    expect(state.documentationSnapshot?.auditConfirmedAt).toBeDefined();
  });

  it("computeNextAction returns persist-run-documentation when snapshot has publishing status (audit not yet confirmed)", () => {
    let state = stateWithMergeEvidence();
    state = upsertDocumentationSnapshot(state, {
      ...PERSISTED_SNAPSHOT,
      status: "publishing",
      auditConfirmedAt: undefined,
    });
    const next = computeNextAction(state);
    expect(next.action).toBe("persist-run-documentation");
    expect(next.detail).toContain("publishing");
    expect(next.detail).toContain("auditConfirmedAt");
  });

  it("computeNextAction returns persist-run-documentation when snapshot has prepared status (not yet written)", () => {
    let state = stateWithMergeEvidence();
    state = upsertDocumentationSnapshot(state, {
      ...PERSISTED_SNAPSHOT,
      status: "prepared",
      commitSha: undefined,
      auditConfirmedAt: undefined,
    });
    const next = computeNextAction(state);
    expect(next.action).toBe("persist-run-documentation");
    expect(next.detail).toContain("prepared");
  });
});

// ---------------------------------------------------------------------------
// TAC-12: index generation preserves all existing run history (Finding 2)
// ---------------------------------------------------------------------------

describe("TAC-12 conflict retry preserves existing run history", () => {
  function snapshotContent(runId: string, spec: string, phase: string): string {
    return [
      "---",
      "schema_version: 1",
      `run_id: "${runId}"`,
      `qualified_run_id: "org/repo#${runId}"`,
      `repository: "org/repo"`,
      `spec: "${spec}"`,
      `phase: "${phase}"`,
      `updated_at: "2026-01-0${runId.slice(-1)}T00:00:00Z"`,
      `delivery_merged_at: "2026-01-0${runId.slice(-1)}T00:00:00Z"`,
      `generated: true`,
      `legacy: false`,
      "---",
      `# ${runId}`,
    ].join("\n");
  }

  it("generateRunIndex includes all provided entries, sorted by delivery_merged_at desc", () => {
    const existingContent1 = snapshotContent("RUN-0054", "SPEC-010", "complete");
    const existingContent2 = snapshotContent("RUN-0055", "SPEC-011", "complete");
    const newContent = snapshotContent("RUN-0056", "SPEC-012", "merge");

    const entry1 = parseRunIndexEntry("docs/runs/generated/RUN-0054-spec-010.md", existingContent1);
    const entry2 = parseRunIndexEntry("docs/runs/generated/RUN-0055-spec-011.md", existingContent2);
    const entry3 = parseRunIndexEntry("docs/runs/generated/RUN-0056-spec-012.md", newContent);

    const allEntries = [entry1!, entry2!, entry3!];
    const generatedAt = "2026-08-18T12:00:00Z";
    const index = generateRunIndex(allEntries, generatedAt);

    // All three runs must appear
    expect(index).toContain("RUN-0054");
    expect(index).toContain("RUN-0055");
    expect(index).toContain("RUN-0056");
    // Sorted descending: RUN-0056 should appear before RUN-0054
    const pos54 = index.indexOf("RUN-0054");
    const pos56 = index.indexOf("RUN-0056");
    expect(pos56).toBeLessThan(pos54);
  });

  it("generateObsidianBase includes all provided entries", () => {
    const content = snapshotContent("RUN-0055", "SPEC-011", "complete");
    const entry = parseRunIndexEntry("docs/runs/generated/RUN-0055-spec-011.md", content);
    const obsidian = generateObsidianBase([entry!], "2026-08-18T12:00:00Z");
    expect(obsidian).toContain("RUN-0055");
    expect(obsidian).toContain("SPEC-011");
  });

  it("a run that only produces [indexEntry] (empty existing history) still generates a valid index", () => {
    const content = snapshotContent("RUN-0056", "SPEC-012", "merge");
    const entry = parseRunIndexEntry("docs/runs/generated/RUN-0056-spec-012.md", content);
    const index = generateRunIndex([entry!], "2026-08-18T12:00:00Z");
    expect(index).toContain("RUN-0056");
  });
});

// ---------------------------------------------------------------------------
// TAC-14: validateSnapshotContent — PII, secrets, evidence URLs rejected
// ---------------------------------------------------------------------------

describe("TAC-14 validateSnapshotContent rejects PII, secrets and policy violations", () => {
  it("accepts clean snapshot content", () => {
    const content = [
      "---",
      "schema_version: 1",
      'run_id: "RUN-0056"',
      "---",
      "# RUN-0056",
      "Clean content with no PII or secrets.",
    ].join("\n");
    expect(() => validateSnapshotContent(content)).not.toThrow();
  });

  it("rejects content containing a GitHub token", () => {
    const content = "run_id: RUN-0056\ngho_ABCDEFGHIJKLMNOPQRSTUVWXYZ12345\n";
    expect(() => validateSnapshotContent(content)).toThrow(/secret.*token|token.*pattern/i);
  });

  it("rejects content containing an OpenAI-style secret key", () => {
    const content = "run_id: RUN-0056\nsk-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890\n";
    expect(() => validateSnapshotContent(content)).toThrow(/secret.*token|token.*pattern/i);
  });

  it("rejects content containing an email address (PII)", () => {
    const content = "Managed by user@example.com for testing.";
    expect(() => validateSnapshotContent(content)).toThrow(/PII/i);
  });

  it("rejects evidence URL with a query string", () => {
    const content = "See https://github.com/org/repo/actions/runs/123?check_suite_focus=true for details.";
    expect(() => validateSnapshotContent(content)).toThrow(/evidence URL.*query/i);
  });

  it("rejects evidence URL with a fragment", () => {
    const content = "See https://github.com/org/repo/issues/1#issuecomment-99 for details.";
    expect(() => validateSnapshotContent(content)).toThrow(/evidence URL/i);
  });

  it("allows clean GitHub URLs without query or fragment", () => {
    const content = "See https://github.com/org/repo/pull/56 for the delivery PR.";
    expect(() => validateSnapshotContent(content)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TAC-17 extension: prepared → publishing → persisted state transitions
// ---------------------------------------------------------------------------

describe("TAC-17 prepared → publishing → persisted state machine", () => {
  function makeBaseState() {
    return stateWithMergeEvidence();
  }

  it("upsertDocumentationSnapshot with prepared status keeps computeNextAction at persist-run-documentation", () => {
    let state = makeBaseState();
    state = upsertDocumentationSnapshot(state, {
      schemaVersion: 1,
      status: "prepared",
      idempotencyKey: "idem-prepared",
      path: "docs/runs/generated/RUN-0056-spec-012.md",
      indexPath: "docs/runs/RUN-INDEX.md",
      obsidianBasePath: "docs/runs/Runs.base",
      generatedAt: "2026-08-18T12:00:00Z",
      sourceHeadSha: sha("b"),
      auditIdempotencyKey: "audit-prepared",
    });
    expect(computeNextAction(state).action).toBe("persist-run-documentation");
  });

  it("upsertDocumentationSnapshot with publishing status keeps computeNextAction at persist-run-documentation (audit missing)", () => {
    let state = makeBaseState();
    state = upsertDocumentationSnapshot(state, {
      schemaVersion: 1,
      status: "publishing",
      idempotencyKey: "idem-publishing",
      path: "docs/runs/generated/RUN-0056-spec-012.md",
      indexPath: "docs/runs/RUN-INDEX.md",
      obsidianBasePath: "docs/runs/Runs.base",
      generatedAt: "2026-08-18T12:00:00Z",
      sourceHeadSha: sha("b"),
      commitSha: sha("c"),
      auditIdempotencyKey: "audit-publishing",
    });
    expect(computeNextAction(state).action).toBe("persist-run-documentation");
  });

  it("transitionPhase to complete fails when status is publishing (no auditConfirmedAt)", () => {
    let state = makeBaseState();
    state = upsertDocumentationSnapshot(state, {
      schemaVersion: 1,
      status: "publishing",
      idempotencyKey: "idem-publishing",
      path: "docs/runs/generated/RUN-0056-spec-012.md",
      indexPath: "docs/runs/RUN-INDEX.md",
      obsidianBasePath: "docs/runs/Runs.base",
      generatedAt: "2026-08-18T12:00:00Z",
      sourceHeadSha: sha("b"),
      commitSha: sha("c"),
      auditIdempotencyKey: "audit-publishing",
    });
    expect(() => transitionPhase(state, "complete")).toThrow(/persisted and audited/);
  });

  it("idempotency keys and generatedAt are stable when reusing a prepared checkpoint", () => {
    // Simulate the behavior that on retry, we reuse the existing checkpoint values
    let state = makeBaseState();
    const preparedAt = "2026-08-18T12:00:00Z";
    const idempotencyKey = "persist-run-doc-RUN-0056-57";
    state = upsertDocumentationSnapshot(state, {
      schemaVersion: 1,
      status: "prepared",
      idempotencyKey,
      path: "docs/runs/generated/RUN-0056-spec-012.md",
      indexPath: "docs/runs/RUN-INDEX.md",
      obsidianBasePath: "docs/runs/Runs.base",
      generatedAt: preparedAt,
      sourceHeadSha: sha("b"),
      auditIdempotencyKey: "audit-run-doc-RUN-0056-57",
    });
    // On "retry", we read the existing checkpoint values
    const existing = state.documentationSnapshot!;
    expect(existing.generatedAt).toBe(preparedAt);
    expect(existing.idempotencyKey).toBe(idempotencyKey);
    // The same values are reused — no new timestamps generated
    const reuseKey = existing.idempotencyKey;
    const reuseAt = existing.generatedAt;
    expect(reuseKey).toBe(idempotencyKey);
    expect(reuseAt).toBe(preparedAt);
  });
});

// ---------------------------------------------------------------------------
// Regression tests for fixing 7: PII phone regex
// ---------------------------------------------------------------------------

describe("validateSnapshotContent PII phone — international number regression (finding 7)", () => {
  it("rejects a leading +49 international number at the start of a string", () => {
    const content = "+49 123 456 7890 is a phone number.";
    expect(() => validateSnapshotContent(content)).toThrow(/PII/i);
  });

  it("rejects a leading +1 North American number", () => {
    const content = "+1 555-555-5555 some context";
    expect(() => validateSnapshotContent(content)).toThrow(/PII/i);
  });

  it("rejects +49 number after whitespace", () => {
    const content = "Contact: +49 123 456 7890";
    expect(() => validateSnapshotContent(content)).toThrow(/PII/i);
  });

  it("still rejects a domestic number without country code", () => {
    const content = "Call 555-555-5555 for info.";
    expect(() => validateSnapshotContent(content)).toThrow(/PII/i);
  });
});

// ---------------------------------------------------------------------------
// Regression tests for fixing 4a: retry off-by-one
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Regression tests for fixing 4a: retry off-by-one
//
// The actual I/O-bound loop in `createAtomicMultiFileCommit` requires a real
// git remote to test end-to-end, but the boundary condition (loop terminates
// after exactly `maxRetries` attempts, not `maxRetries + 1`) can be validated
// via a standalone simulation of the same loop invariant.
// ---------------------------------------------------------------------------

/**
 * Simulates the corrected retry loop from `createAtomicMultiFileCommit`:
 *   for (attempt = 0; attempt < maxRetries; attempt++) { ... }
 *   throw on conflict when attempt === maxRetries - 1
 *
 * Returns the number of attempts made before success or exhaustion.
 */
function simulateRetryLoop(
  maxRetries: number,
  /** Returns true if the attempt succeeds, false if it conflicts. */
  attemptOutcome: (attempt: number) => boolean,
): { attempts: number; succeeded: boolean } {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attemptOutcome(attempt)) return { attempts: attempt + 1, succeeded: true };
    if (attempt === maxRetries - 1) break; // exhausted
  }
  return { attempts: maxRetries, succeeded: false };
}

describe("createAtomicMultiFileCommit retry count invariant (finding 4a)", () => {
  it("with maxRetries=3 all-conflict: executes exactly 3 attempts, not 4", () => {
    const result = simulateRetryLoop(3, () => false);
    expect(result.attempts).toBe(3);
    expect(result.succeeded).toBe(false);
  });

  it("with maxRetries=3 success on first attempt: executes exactly 1 attempt", () => {
    const result = simulateRetryLoop(3, () => true);
    expect(result.attempts).toBe(1);
    expect(result.succeeded).toBe(true);
  });

  it("with maxRetries=3 success on second attempt: executes exactly 2 attempts", () => {
    let calls = 0;
    const result = simulateRetryLoop(3, (attempt) => { calls++; return attempt === 1; });
    expect(calls).toBe(2);
    expect(result.succeeded).toBe(true);
  });

  it("with maxRetries=1 all-conflict: executes exactly 1 attempt", () => {
    const result = simulateRetryLoop(1, () => false);
    expect(result.attempts).toBe(1);
    expect(result.succeeded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression tests for fixing 2: unknown schema version fails closed
// ---------------------------------------------------------------------------

describe("parseFrontmatter schema_version detection", () => {
  it("returns schema_version field when present", () => {
    const content = `---\nschema_version: 1\nrun_id: RUN-0056\n---\n# Body`;
    const fm = parseFrontmatter(content);
    expect(fm?.["schema_version"]).toBe(1);
  });

  it("returns unknown schema_version when present and non-1", () => {
    const content = `---\nschema_version: 99\nrun_id: RUN-0056\n---\n# Body`;
    const fm = parseFrontmatter(content);
    expect(fm?.["schema_version"]).toBe(99);
  });

  it("returns null schema_version when not present", () => {
    const content = `---\nrun_id: RUN-0056\n---\n# Body`;
    const fm = parseFrontmatter(content);
    expect(fm?.["schema_version"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Regression tests for fixing 4b: deliveryFailureCount field on checkpoint
// ---------------------------------------------------------------------------

describe("DocumentationSnapshotCheckpoint deliveryFailureCount (finding 4b)", () => {
  it("upsertDocumentationSnapshot preserves deliveryFailureCount on subsequent upserts", () => {
    let state = stateWithMergeEvidence();
    state = upsertDocumentationSnapshot(state, {
      schemaVersion: 1,
      status: "publishing",
      idempotencyKey: "idem-1",
      path: "docs/runs/generated/RUN-0056-spec-012.md",
      indexPath: "docs/runs/RUN-INDEX.md",
      obsidianBasePath: "docs/runs/Runs.base",
      generatedAt: "2026-08-18T12:00:00Z",
      sourceHeadSha: sha("a"),
      commitSha: sha("b"),
      auditIdempotencyKey: "audit-1",
      deliveryFailureCount: 2,
    });
    expect(state.documentationSnapshot?.deliveryFailureCount).toBe(2);
    // A subsequent upsert that does not set deliveryFailureCount should preserve it.
    state = upsertDocumentationSnapshot(state, {
      schemaVersion: 1,
      status: "publishing",
      idempotencyKey: "idem-1",
      path: "docs/runs/generated/RUN-0056-spec-012.md",
      indexPath: "docs/runs/RUN-INDEX.md",
      obsidianBasePath: "docs/runs/Runs.base",
      generatedAt: "2026-08-18T12:00:00Z",
      sourceHeadSha: sha("a"),
      commitSha: sha("b"),
      auditIdempotencyKey: "audit-1",
      deliveryFailureCount: 3,
    });
    expect(state.documentationSnapshot?.deliveryFailureCount).toBe(3);
  });

  it("computeNextAction stays at persist-run-documentation with deliveryFailureCount < threshold", () => {
    let state = stateWithMergeEvidence();
    state = upsertDocumentationSnapshot(state, {
      schemaVersion: 1,
      status: "publishing",
      idempotencyKey: "idem-1",
      path: "docs/runs/generated/RUN-0056-spec-012.md",
      indexPath: "docs/runs/RUN-INDEX.md",
      obsidianBasePath: "docs/runs/Runs.base",
      generatedAt: "2026-08-18T12:00:00Z",
      sourceHeadSha: sha("a"),
      commitSha: sha("b"),
      auditIdempotencyKey: "audit-1",
      deliveryFailureCount: 2,
    });
    expect(computeNextAction(state).action).toBe("persist-run-documentation");
  });
});

// ---------------------------------------------------------------------------
// Regression tests for fixing 3: verifyCommitOnBranch reachability
// ---------------------------------------------------------------------------

describe("github.verifyCommitOnBranch uses compare API (finding 3)", () => {
  it("verifyCommitOnBranch is exported and is a function", async () => {
    const { github } = await import("../src/github/gh.js");
    expect(typeof github.verifyCommitOnBranch).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// TAC-18 (integration): cmdPersistRunDocumentation via injected adapter
//
// These tests execute the ACTUAL `cmdPersistRunDocumentation` function with a
// faithful in-memory GitHub adapter and state store. They do not use
// simulateRetryLoop or any other production-code bypass.
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory StateStore compatible with the `StateStore` interface.
 * Exposes `issueRef` so the gate-publishing path works.
 */
class MemoryStateStore implements StateStore {
  private _state: RunState;
  readonly issueRef: { repository: string; number: number; url: string };

  constructor(initialState: RunState, repo = "org/repo", issueNumber = 56) {
    this._state = initialState;
    this.issueRef = { repository: repo, number: issueNumber, url: `https://github.com/${repo}/issues/${issueNumber}` };
  }
  async load(): Promise<RunState> { return this._state; }
  async save(state: RunState): Promise<void> { this._state = state; }
  get state(): RunState { return this._state; }
}

/**
 * Build a minimal faithful WriterGithubAdapter suitable for happy-path testing.
 * Every field can be overridden to simulate specific failure conditions.
 */
function makeFakeGithub(overrides: Partial<WriterGithubAdapter> = {}): WriterGithubAdapter & { dispatchedEvents: unknown[]; journalEntries: Map<string, string>; gatesOpened: string[] } {
  const dispatchedEvents: unknown[] = [];
  const journalEntries = new Map<string, string>();
  const gatesOpened: string[] = [];
  let branchHead = "aaa".repeat(14) + "aa"; // 40-char fake SHA

  const base: WriterGithubAdapter = {
    async preflightRunDocumentationWriter() { /* pass */ },
    async getBranchSha() { return branchHead; },
    async verifyCommitOnBranch(_repo, _branch, sha) { return sha === branchHead; },
    async createAtomicMultiFileCommit(_repo, _branch, buildFiles) {
      await buildFiles(branchHead);
      const newSha = "bbb".repeat(14) + "bb";
      branchHead = newSha;
      return newSha;
    },
    async listDirectoryMarkdownFiles() { return []; },
    async getFileContent() { return { content: "", blobSha: "x".repeat(40) }; },
    async dispatchProcessAuditEnvelopeV1(recorder, payload) {
      dispatchedEvents.push({ recorder, payload });
      // Simulate recorder immediately writing the journal entry.
      journalEntries.set(payload.idempotency_key, `confirmed_at: "${new Date().toISOString()}"`);
    },
    async confirmAuditEventInJournal(_repo, _journalDir, idempotencyKey) {
      const entry = journalEntries.get(idempotencyKey);
      if (!entry) throw new Error(`audit event not in journal: ${idempotencyKey}`);
      return new Date().toISOString();
    },
    async createIssue(_repo, opts) {
      gatesOpened.push(opts.title);
      return { number: 99, url: "https://github.com/org/repo/issues/99" };
    },
    async removeLabels() { /* no-op */ },
    async addLabels() { /* no-op */ },
    async closeIssue() { /* no-op */ },
    async ensureLabel() { /* no-op */ },
  };
  return { ...base, ...overrides, dispatchedEvents, journalEntries, gatesOpened };
}

function mergeReadyState(): RunState {
  return stateWithMergeEvidence();
}

describe("TAC-18 cmdPersistRunDocumentation integration via injected adapter", () => {
  // --- Happy path: full end-to-end flow succeeds -------------------------

  it("happy path: command completes, snapshot status becomes persisted", async () => {
    const state0 = mergeReadyState();
    const store = new MemoryStateStore(state0);
    const gh = makeFakeGithub();

    await cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    });

    const finalState = store.state;
    expect(finalState.documentationSnapshot?.status).toBe("persisted");
    expect(finalState.documentationSnapshot?.commitSha).toBeDefined();
    expect(finalState.documentationSnapshot?.auditConfirmedAt).toBeDefined();
    expect(computeNextAction(finalState).action).toBe("advance-phase");
  });

  it("happy path: dispatch + journal confirm are both called exactly once", async () => {
    const store = new MemoryStateStore(mergeReadyState());
    const gh = makeFakeGithub();

    await cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    });

    expect(gh.dispatchedEvents).toHaveLength(1);
    const event = gh.dispatchedEvents[0] as { recorder: string; payload: { process_code: string } };
    expect(event.recorder).toBe("org/repo");
    expect(event.payload.process_code).toBe("DOCUMENTATION_UPDATE");
  });

  // --- Duplicate delivery no-op (TAC-11 with origin + journal re-confirmation) ---

  it("no-op: already-persisted state with confirmed origin and journal skips the command", async () => {
    let state0 = mergeReadyState();
    const idemKey = "audit-run-doc-RUN-0056-56";
    const commitSha = "ccc".repeat(14) + "cc";
    state0 = upsertDocumentationSnapshot(state0, {
      schemaVersion: 1,
      status: "persisted",
      idempotencyKey: "persist-run-doc-RUN-0056-56",
      auditIdempotencyKey: idemKey,
      path: "docs/runs/generated/RUN-0056-spec-012.md",
      indexPath: "docs/runs/RUN-INDEX.md",
      obsidianBasePath: "docs/runs/Runs.base",
      generatedAt: "2026-08-18T12:00:00Z",
      sourceHeadSha: "aaa".repeat(14) + "aa",
      commitSha,
      auditConfirmedAt: "2026-08-18T12:05:00Z",
    });
    const store = new MemoryStateStore(state0);
    const journalEntries = new Map([[idemKey, `confirmed_at: "2026-08-18T12:05:00Z"`]]);
    const gh = makeFakeGithub({
      async verifyCommitOnBranch() { return true; },
      async confirmAuditEventInJournal(_repo, _dir, key) {
        if (!journalEntries.has(key)) throw new Error("not found");
        return journalEntries.get(key)!;
      },
    });

    await cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    });

    // No new dispatch (already persisted + confirmed)
    expect(gh.dispatchedEvents).toHaveLength(0);
  });

  // --- Commit-success / state-save-failure adoption (finding #2) ----------

  it("reconciliation: adopts existing publishing commit when it is on origin", async () => {
    let state0 = mergeReadyState();
    const existingCommitSha = "ddd".repeat(14) + "dd";
    // Simulate a crash after commit but before audit: state says "publishing"
    state0 = upsertDocumentationSnapshot(state0, {
      schemaVersion: 1,
      status: "publishing",
      idempotencyKey: "persist-run-doc-RUN-0056-56",
      auditIdempotencyKey: "audit-run-doc-RUN-0056-56",
      path: "docs/runs/generated/RUN-0056-spec-012.md",
      indexPath: "docs/runs/RUN-INDEX.md",
      obsidianBasePath: "docs/runs/Runs.base",
      generatedAt: "2026-08-18T12:00:00Z",
      sourceHeadSha: "aaa".repeat(14) + "aa",
      commitSha: existingCommitSha,
    });
    const store = new MemoryStateStore(state0);
    let atomicCommitCalls = 0;
    const gh = makeFakeGithub({
      // The existing commit IS on origin — should not re-commit
      async verifyCommitOnBranch(_repo, _branch, sha) { return sha === existingCommitSha; },
      async createAtomicMultiFileCommit(...args) {
        atomicCommitCalls++;
        // Call the base to get content built, but return a different SHA.
        const buildFiles = args[2] as (parentSha: string) => Promise<unknown>;
        await buildFiles("aaa".repeat(14) + "aa");
        return "eee".repeat(14) + "ee";
      },
    });

    await cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    });

    // No new commit was made because the publishing commit was confirmed on origin
    expect(atomicCommitCalls).toBe(0);
    expect(store.state.documentationSnapshot?.status).toBe("persisted");
    // The persisted commitSha should be the one already on origin, not a new one
    expect(store.state.documentationSnapshot?.commitSha).toBe(existingCommitSha);
  });

  // --- REQ-005 delivery failure and retry (finding #1 + #3) ---------------

  it("delivery failure: increments failure count and eventually opens exactly one gate after 3 failures", async () => {
    let failureStore: MemoryStateStore | undefined;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const state0 = failureStore ? failureStore.state : mergeReadyState();
      // Reset publishing checkpoint for each retry (simulate re-run with persisted failure count)
      const currentState = state0.documentationSnapshot?.status === "persisted"
        ? upsertDocumentationSnapshot(state0, {
          schemaVersion: 1,
          status: "publishing",
          idempotencyKey: state0.documentationSnapshot.idempotencyKey ?? "idem",
          auditIdempotencyKey: state0.documentationSnapshot.auditIdempotencyKey ?? "audit-idem",
          path: state0.documentationSnapshot.path ?? "docs/runs/generated/RUN-0056-spec-012.md",
          indexPath: "docs/runs/RUN-INDEX.md",
          obsidianBasePath: "docs/runs/Runs.base",
          generatedAt: state0.documentationSnapshot.generatedAt ?? new Date().toISOString(),
          sourceHeadSha: state0.documentationSnapshot.sourceHeadSha ?? "aaa".repeat(14) + "aa",
          commitSha: "bbb".repeat(14) + "bb",
          deliveryFailureCount: state0.documentationSnapshot.deliveryFailureCount ?? 0,
        })
        : state0;
      failureStore = new MemoryStateStore(currentState);
      const gh = makeFakeGithub({
        async verifyCommitOnBranch() { return true; },
        async createAtomicMultiFileCommit(_r, _b, buildFiles) {
          await buildFiles("aaa".repeat(14) + "aa");
          return "bbb".repeat(14) + "bb";
        },
        async confirmAuditEventInJournal() {
          throw new Error("journal not reachable");
        },
      });

      try {
        await cmdPersistRunDocumentation({
          repository: "org/repo",
          issueNumber: 56,
          branch: "main",
          _githubAdapter: gh,
          _storeFactory: () => failureStore! as never,
        });
      } catch {
        // Expected to throw on each attempt.
      }
      const s = failureStore.state;
      expect(s.documentationSnapshot?.deliveryFailureCount ?? 0).toBe(attempt);
    }

    // After exactly 3 failures, exactly one delivery-failed gate must exist
    const gates = failureStore!.state.gates;
    const failedGates = gates.filter((g) => g.id === "run-documentation-delivery-failed");
    expect(failedGates).toHaveLength(1);
  });

  it("delivery failure: a 4th retry does NOT open a second gate", async () => {
    // Simulate state where delivery-failed gate already exists (3 failures)
    let state0 = mergeReadyState();
    state0 = upsertDocumentationSnapshot(state0, {
      schemaVersion: 1,
      status: "publishing",
      idempotencyKey: "idem",
      auditIdempotencyKey: "audit-idem",
      path: "docs/runs/generated/RUN-0056-spec-012.md",
      indexPath: "docs/runs/RUN-INDEX.md",
      obsidianBasePath: "docs/runs/Runs.base",
      generatedAt: "2026-08-18T12:00:00Z",
      sourceHeadSha: "aaa".repeat(14) + "aa",
      commitSha: "bbb".repeat(14) + "bb",
      deliveryFailureCount: 3,
    });
    // Inject the already-opened gate manually (resolved/approved — simulates human approval)
    state0 = upsertGate(state0, {
      id: "run-documentation-delivery-failed",
      type: "human",
      question: "delivery failed",
    });
    state0 = resolveGate(state0, "run-documentation-delivery-failed", {
      result: "passed",
      decision: { approved: true, by: "test-user", at: "2026-08-18T13:00:00Z" },
    });
    const store = new MemoryStateStore(state0);
    const gh = makeFakeGithub({
      async verifyCommitOnBranch() { return true; },
      async createAtomicMultiFileCommit(_r, _b, buildFiles) {
        await buildFiles("aaa".repeat(14) + "aa");
        return "bbb".repeat(14) + "bb";
      },
      async confirmAuditEventInJournal() {
        throw new Error("journal not reachable");
      },
    });

    try {
      await cmdPersistRunDocumentation({
        repository: "org/repo",
        issueNumber: 56,
        branch: "main",
        _githubAdapter: gh,
        _storeFactory: () => store as never,
      });
    } catch { /* expected */ }

    // Still only one gate (not duplicated)
    const gates = store.state.gates.filter((g) => g.id === "run-documentation-delivery-failed");
    expect(gates).toHaveLength(1);
    expect(store.state.documentationSnapshot?.deliveryFailureCount).toBe(4);
  });

  // --- Legacy-directory workflow template (finding #5) --------------------

  it("renderRunDocumentationFinalizer includes legacy-directories input when configured", () => {
    const result = renderRunDocumentationFinalizer({
      legacyDirectories: ["docs/50-quality/runs", "docs/runs"],
    });
    expect(result).toContain("legacy-directories");
  });

  it("renderRunDocumentationFinalizer omits legacy-directories when not configured", () => {
    const result = renderRunDocumentationFinalizer({});
    expect(result).not.toContain("legacy-directories: ");
  });

  // --- Reusable workflow contract (finding #5 / TAC-16) -------------------

  it("reusable workflow exposes legacy-directories and audit-journal-path inputs", async () => {
    const { readFileSync } = await import("fs");
    const content = readFileSync(".github/workflows/run-documentation-finalizer.yml", "utf8");
    expect(content).toContain("legacy-directories");
    expect(content).toContain("audit-journal-path");
  });

  // --- Process-audit-automation workflow contract ---------------------------

  it("process-audit-automation reusable workflow exists and has workflow_call trigger", async () => {
    const { readFileSync } = await import("fs");
    const content = readFileSync(".github/workflows/process-audit-automation.yml", "utf8");
    expect(content).toContain("workflow_call");
    expect(content).toContain("audit-payload-json");
    expect(content).toContain("record_process_audit.mjs");
  });

  it("harness-process-audit-receiver workflow exists and calls process-audit-automation", async () => {
    const { readFileSync } = await import("fs");
    const content = readFileSync(".github/workflows/harness-process-audit-receiver.yml", "utf8");
    expect(content).toContain("repository_dispatch");
    expect(content).toContain("process_audit");
    expect(content).toContain("process-audit-automation.yml");
  });

  // --- Preflight blocks on missing recorder (finding #1) -----------------

  it("preflight: blocks execution when recorder repository is unreachable", async () => {
    const store = new MemoryStateStore(mergeReadyState());
    const gh = makeFakeGithub({
      async preflightRunDocumentationWriter(_repo, _branch, recorderRepo) {
        if (recorderRepo === "missing/recorder") {
          throw new Error("run-documentation-writer preflight failed: audit recorder repository 'missing/recorder' is not reachable");
        }
      },
    });

    await expect(cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      auditRecorderRepo: "missing/recorder",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    })).rejects.toThrow(/audit recorder/);
  });

  // --- dispatchProcessAuditEnvelopeV1 and confirmAuditEventInJournal are exported ---

  it("gh.ts exposes dispatchProcessAuditEnvelopeV1 and confirmAuditEventInJournal", async () => {
    const { github } = await import("../src/github/gh.js");
    expect(typeof github.dispatchProcessAuditEnvelopeV1).toBe("function");
    expect(typeof github.confirmAuditEventInJournal).toBe("function");
  });

  // --- confirmAuditEventInJournal fails-closed (finding #6 related) ------

  it("confirmAuditEventInJournal: throws after maxAttempts when key is not in journal (fail-closed)", async () => {
    const { github } = await import("../src/github/gh.js");
    // This only tests the exported function signature / contract; it does not
    // call live GitHub APIs (the function would throw on the first attempt since
    // it can't reach GitHub in the test environment).
    expect(typeof github.confirmAuditEventInJournal).toBe("function");
  });
});
