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
 * - TAC-16: renderRunDocumentationFinalizer() — minimal permissions, no secrets:inherit, cancel-in-progress: false
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
import { validateDocumentationPath, validateStagedPaths, normalizePath } from "../src/documentation/path-validator.js";
import {
  renderRunDocumentationFinalizer,
  RUN_DOCUMENTATION_FINALIZER_MARKER,
} from "../src/workflows/template-catalog.js";

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
});
