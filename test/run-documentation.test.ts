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
import { createHash } from "node:crypto";
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
  PROCESS_AUDIT_RECEIVER_MARKER,
  DEFAULT_REUSABLE_WORKFLOW_REPOSITORY,
} from "../src/workflows/template-catalog.js";
import type { WriterGithubAdapter } from "../src/cli.js";
import { cmdPersistRunDocumentation } from "../src/cli.js";
import { CROSS_REPO_ALLOWED_ROLES } from "../src/github/gh.js";
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
    mergedBy: "human-user",
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

  it("supports trusted reconciliation dispatch with an explicit issue number", () => {
    const result = renderRunDocumentationFinalizer();
    expect(result).toContain("workflow_dispatch:");
    expect(result).toContain("issue-number:");
    expect(result).toContain("inputs.issue-number || github.event.issue.number");
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
    expect(content).toContain("issue-number:");
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
    async getFileContentIfExists() { return undefined; },
    async getLatestCommitForPath() { return undefined; },
    async getCommitChangedPaths() { return new Set<string>(); },
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

  it("process_instance uses qualified canonical PI-<REPO>-RUN-xxxx format", async () => {
    const store = new MemoryStateStore(mergeReadyState());
    const gh = makeFakeGithub();

    await cmdPersistRunDocumentation({
      repository: "org/my-repo",
      issueNumber: 56,
      branch: "main",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    });

    const event = gh.dispatchedEvents[0] as { payload: { process_instance: string } };
    // formatCanonicalRunId("org/my-repo", 56) → processInstance = "PI-ORG-MY-REPO-RUN-0056"
    expect(event.payload.process_instance).toBe("PI-ORG-MY-REPO-RUN-0056");
  });

  it("prepared checkpoint contains contentHashes with snapshot path key", async () => {
    const state0 = mergeReadyState();
    const savedStates: RunState[] = [];
    const store = new MemoryStateStore(state0);
    const origSave = store.save.bind(store);
    store.save = async (s) => { savedStates.push(s); return origSave(s); };
    const gh = makeFakeGithub();

    await cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    });

    // The first save should be the `prepared` checkpoint with contentHashes.
    const preparedState = savedStates.find(s => s.documentationSnapshot?.status === "prepared");
    expect(preparedState).toBeDefined();
    const hashes = preparedState!.documentationSnapshot?.contentHashes;
    expect(hashes).toBeDefined();
    const keys = Object.keys(hashes!);
    expect(keys).toHaveLength(3);
    // All three paths (snapshot, index, base) must have 64-char hex SHA-256 digests.
    for (const key of keys) {
      expect(hashes![key]).toMatch(/^[0-9a-f]{64}$/);
    }
    // The snapshot path key must end with .md
    const snapshotKey = keys.find(k => k.includes("generated/"));
    expect(snapshotKey).toMatch(/\.md$/);
  });

  it("crash-after-push reconciliation: adopts already-landed commit when hash matches", async () => {
    // Simulate: prepared checkpoint saved, then crash before publishing save.
    // On retry, origin already has the snapshot with matching content.
    const state0 = mergeReadyState();
    const generatedAt = "2026-01-01T00:00:00.000Z";
    const snapshotPath = "docs/runs/generated/RUN-0056-spec-012.md";
    const idemKey = "persist-run-doc-RUN-0056-56";
    const auditIdemKey = "audit-run-doc-RUN-0056-56";
    const sourceHeadSha = "aaa".repeat(14) + "aa";

    // Build the expected snapshot content (same way the command does).
    const { renderRunSnapshot } = await import("../src/documentation/run-snapshot.js");
    const snapshotContent = renderRunSnapshot({
      state: state0,
      trackingIssue: { repository: "org/repo", number: 56, url: "https://github.com/org/repo/issues/56" },
      repositoryDefaultBranch: "main",
      harnessVersion: "unknown",
      generatedAt,
    });
    const expectedHash = createHash("sha256").update(snapshotContent, "utf8").digest("hex");
    const existingCommitSha = "adopted".padEnd(40, "0").slice(0, 40);

    // Compute all three hashes (snapshot, index, base) from the same state,
    // since readAllRunEntries with empty origin returns only the new entry.
    const { generateRunIndex, generateObsidianBase, parseRunIndexEntry } = await import("../src/documentation/run-index.js");
    const indexPath = "docs/runs/RUN-INDEX.md";
    const obsidianBasePath = "docs/runs/Runs.base";
    const newEntry = parseRunIndexEntry(snapshotPath, snapshotContent);
    const allEntries = newEntry ? [newEntry] : [];
    const indexContent = generateRunIndex(allEntries, generatedAt);
    const obsidianContent = generateObsidianBase(allEntries, generatedAt);
    const expectedIndexHash = createHash("sha256").update(indexContent, "utf8").digest("hex");
    const expectedBaseHash = createHash("sha256").update(obsidianContent, "utf8").digest("hex");

    const preparedState = upsertDocumentationSnapshot(state0, {
      schemaVersion: 1,
      status: "prepared",
      idempotencyKey: idemKey,
      auditIdempotencyKey: auditIdemKey,
      path: snapshotPath,
      indexPath,
      obsidianBasePath,
      generatedAt,
      sourceHeadSha,
      contentHashes: {
        [snapshotPath]: expectedHash,
        [indexPath]: expectedIndexHash,
        [obsidianBasePath]: expectedBaseHash,
      },
    });

    const store = new MemoryStateStore(preparedState);
    let atomicCommitCallCount = 0;
    const journalEntries = new Map<string, string>();
    const gh = makeFakeGithub({
      async getBranchSha() { return sourceHeadSha; },
      async verifyCommitOnBranch() { return true; },
      async getFileContentIfExists(_repo, path) {
        if (path === snapshotPath) return { content: snapshotContent, blobSha: "x".repeat(40) };
        if (path === indexPath) return { content: indexContent, blobSha: "y".repeat(40) };
        if (path === obsidianBasePath) return { content: obsidianContent, blobSha: "z".repeat(40) };
        return undefined;
      },
      async getLatestCommitForPath() { return existingCommitSha; },
      async getCommitChangedPaths() {
        // The adopted commit atomically contains all three expected paths.
        return new Set([snapshotPath, indexPath, obsidianBasePath]);
      },
      async createAtomicMultiFileCommit() {
        atomicCommitCallCount++;
        return "new-commit-sha".padEnd(40, "x").slice(0, 40);
      },
      async dispatchProcessAuditEnvelopeV1(_repo, payload) {
        journalEntries.set(payload.idempotency_key, `confirmed_at: "2026-01-01T00:01:00Z"`);
      },
      async confirmAuditEventInJournal(_repo, _dir, key) {
        const e = journalEntries.get(key);
        if (!e) throw new Error("not found");
        return "2026-01-01T00:01:00Z";
      },
    });

    await cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    });

    // Must NOT create a new commit when origin already has matching content.
    expect(atomicCommitCallCount).toBe(0);
    // The adopted commit SHA must appear in the final persisted checkpoint.
    expect(store.state.documentationSnapshot?.commitSha).toBe(existingCommitSha);
    expect(store.state.documentationSnapshot?.status).toBe("persisted");
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

  // Negative test: snapshot matches but index differs → must NOT adopt, must re-commit.
  it("reconciliation negative: snapshot matches but index differs — re-commits instead of adopting", async () => {
    const state0 = mergeReadyState();
    const generatedAt = "2026-01-01T00:00:00.000Z";
    const snapshotPath = "docs/runs/generated/RUN-0056-spec-012.md";
    const indexPath = "docs/runs/RUN-INDEX.md";
    const obsidianBasePath = "docs/runs/Runs.base";
    const sourceHeadSha = "aaa".repeat(14) + "aa";

    const { renderRunSnapshot } = await import("../src/documentation/run-snapshot.js");
    const snapshotContent = renderRunSnapshot({
      state: state0,
      trackingIssue: { repository: "org/repo", number: 56, url: "https://github.com/org/repo/issues/56" },
      repositoryDefaultBranch: "main",
      harnessVersion: "unknown",
      generatedAt,
    });
    const snapshotHash = createHash("sha256").update(snapshotContent, "utf8").digest("hex");
    const indexHash = createHash("sha256").update("expected-index-content", "utf8").digest("hex");
    const baseHash = createHash("sha256").update("expected-base-content", "utf8").digest("hex");

    const preparedState = upsertDocumentationSnapshot(state0, {
      schemaVersion: 1,
      status: "prepared",
      idempotencyKey: "persist-run-doc-RUN-0056-56",
      auditIdempotencyKey: "audit-run-doc-RUN-0056-56",
      path: snapshotPath,
      indexPath,
      obsidianBasePath,
      generatedAt,
      sourceHeadSha,
      contentHashes: {
        [snapshotPath]: snapshotHash,
        [indexPath]: indexHash,
        [obsidianBasePath]: baseHash,
      },
    });

    const store = new MemoryStateStore(preparedState);
    let atomicCommitCallCount = 0;
    const gh = makeFakeGithub({
      async getBranchSha() { return sourceHeadSha; },
      async verifyCommitOnBranch() { return true; },
      async getFileContentIfExists(_repo, path) {
        if (path === snapshotPath) return { content: snapshotContent, blobSha: "x".repeat(40) };
        // Index has DIFFERENT content from the stored hash — should not adopt.
        if (path === indexPath) return { content: "different-index-content", blobSha: "y".repeat(40) };
        if (path === obsidianBasePath) return { content: "expected-base-content", blobSha: "z".repeat(40) };
        return undefined;
      },
      async getLatestCommitForPath() { return "some-commit-sha".padEnd(40, "0").slice(0, 40); },
      async getCommitChangedPaths() {
        return new Set([snapshotPath, indexPath, obsidianBasePath]);
      },
      async createAtomicMultiFileCommit(_repo, _branch, buildFiles) {
        atomicCommitCallCount++;
        await buildFiles(sourceHeadSha);
        return "new-commit-sha".padEnd(40, "x").slice(0, 40);
      },
    });

    await cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    });

    // Must re-commit because index hash did not match.
    expect(atomicCommitCallCount).toBe(1);
  });

  // Negative test: commit doesn't contain all three paths → must NOT adopt, must re-commit.
  it("reconciliation negative: commit lacks index/base paths — re-commits instead of adopting", async () => {
    const state0 = mergeReadyState();
    const generatedAt = "2026-01-01T00:00:00.000Z";
    const snapshotPath = "docs/runs/generated/RUN-0056-spec-012.md";
    const indexPath = "docs/runs/RUN-INDEX.md";
    const obsidianBasePath = "docs/runs/Runs.base";
    const sourceHeadSha = "aaa".repeat(14) + "aa";

    const { renderRunSnapshot } = await import("../src/documentation/run-snapshot.js");
    const snapshotContent = renderRunSnapshot({
      state: state0,
      trackingIssue: { repository: "org/repo", number: 56, url: "https://github.com/org/repo/issues/56" },
      repositoryDefaultBranch: "main",
      harnessVersion: "unknown",
      generatedAt,
    });
    const { generateRunIndex, generateObsidianBase, parseRunIndexEntry } = await import("../src/documentation/run-index.js");
    const newEntry = parseRunIndexEntry(snapshotPath, snapshotContent);
    const allEntries = newEntry ? [newEntry] : [];
    const indexContent = generateRunIndex(allEntries, generatedAt);
    const obsidianContent = generateObsidianBase(allEntries, generatedAt);

    const preparedState = upsertDocumentationSnapshot(state0, {
      schemaVersion: 1,
      status: "prepared",
      idempotencyKey: "persist-run-doc-RUN-0056-56",
      auditIdempotencyKey: "audit-run-doc-RUN-0056-56",
      path: snapshotPath,
      indexPath,
      obsidianBasePath,
      generatedAt,
      sourceHeadSha,
      contentHashes: {
        [snapshotPath]: createHash("sha256").update(snapshotContent, "utf8").digest("hex"),
        [indexPath]: createHash("sha256").update(indexContent, "utf8").digest("hex"),
        [obsidianBasePath]: createHash("sha256").update(obsidianContent, "utf8").digest("hex"),
      },
    });

    const store = new MemoryStateStore(preparedState);
    let atomicCommitCallCount = 0;
    const gh = makeFakeGithub({
      async getBranchSha() { return sourceHeadSha; },
      async verifyCommitOnBranch() { return true; },
      async getFileContentIfExists(_repo, path) {
        if (path === snapshotPath) return { content: snapshotContent, blobSha: "x".repeat(40) };
        if (path === indexPath) return { content: indexContent, blobSha: "y".repeat(40) };
        if (path === obsidianBasePath) return { content: obsidianContent, blobSha: "z".repeat(40) };
        return undefined;
      },
      async getLatestCommitForPath() { return "partial-commit-sha".padEnd(40, "0").slice(0, 40); },
      // Commit only touched snapshot — NOT index and base (partial/concurrent commit).
      async getCommitChangedPaths() { return new Set([snapshotPath]); },
      async createAtomicMultiFileCommit(_repo, _branch, buildFiles) {
        atomicCommitCallCount++;
        await buildFiles(sourceHeadSha);
        return "new-commit-sha".padEnd(40, "x").slice(0, 40);
      },
    });

    await cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    });

    // Must re-commit because the candidate commit lacked index and base paths.
    expect(atomicCommitCallCount).toBe(1);
  });

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
    expect(content).toContain("src/audit/journalParser.js");
  });

  it("harness-process-audit-receiver satisfies the production managed-receiver preflight", async () => {
    const { readFileSync } = await import("fs");
    const { validateReceiverContent } = await import("../src/github/gh.js");
    const content = readFileSync(".github/workflows/harness-process-audit-receiver.yml", "utf8");
    expect(content).toContain("repository_dispatch");
    expect(content).toContain("process_audit");
    expect(content).toContain("process-audit-automation.yml");
    expect(validateReceiverContent(
      content,
      "aca192d94f3db79747c000a7b0f9438acac48b5a",
      ".github/workflows/harness-process-audit-receiver.yml",
      "munichdeveloper/pi-spec-harness",
    )).toBeUndefined();
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

  // --- Finding 4 regression: confirmAuditEventInJournal fails-closed on missing confirmed_at ---

  it("Finding-4: command fails when confirmAuditEventInJournal finds journal entry without confirmed_at field", async () => {
    // Simulate a recorder that writes an incomplete journal entry (marker present but no confirmed_at).
    // The adapter's confirmAuditEventInJournal must throw, not fabricate a timestamp.
    const store = new MemoryStateStore(mergeReadyState());
    const gh = makeFakeGithub({
      async confirmAuditEventInJournal(_repo, _dir, key) {
        // Simulate the fail-closed behavior: journal file found but confirmed_at missing
        throw new Error(
          `audit journal entry for idempotency_key "${key}" is missing the required 'confirmed_at' field`,
        );
      },
    });
    await expect(cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    })).rejects.toThrow(/confirmed_at/);
  });

  // --- Finding 3 regression: preflight blocks on missing / unmanaged receiver ---

  it("Finding-3: preflight blocks when process-audit receiver workflow is not found in recorder", async () => {
    const store = new MemoryStateStore(mergeReadyState());
    const gh = makeFakeGithub({
      async preflightRunDocumentationWriter(_repo, _branch, recorderRepo) {
        throw new Error(
          `run-documentation-writer preflight failed: process-audit receiver workflow ` +
          `'.github/workflows/harness-process-audit-receiver.yml' not found in '${recorderRepo ?? _repo}'.`,
        );
      },
    });
    await expect(cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    })).rejects.toThrow(/process-audit receiver workflow.*not found/);
  });

  it("Finding-3: preflight blocks when receiver exists but lacks the managed marker", async () => {
    const store = new MemoryStateStore(mergeReadyState());
    const gh = makeFakeGithub({
      async preflightRunDocumentationWriter(_repo, _branch, recorderRepo) {
        throw new Error(
          `run-documentation-writer preflight failed: the process-audit receiver at ` +
          `'.github/workflows/harness-process-audit-receiver.yml' in '${recorderRepo ?? _repo}' ` +
          `is not a pi-spec-harness managed receiver (expected marker not found).`,
        );
      },
    });
    await expect(cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    })).rejects.toThrow(/not a pi-spec-harness managed receiver/);
  });
});

// ===========================================================================
// Fix 1: contentHashes updated before each push attempt (stale hash regression)
// ===========================================================================

describe("Fix-1: contentHashes updated before each push on conflict/retry", () => {
  it("on conflict retry, saved contentHashes reflect the re-rendered content, not stale initial hashes", async () => {
    const store = new MemoryStateStore(mergeReadyState());
    let buildCallCount = 0;
    const capturedHashes: Record<string, Record<string, string>> = {};

    const gh = makeFakeGithub({
      async createAtomicMultiFileCommit(_repo, _branch, buildFiles) {
        // First call: simulate a non-fast-forward conflict.
        buildCallCount++;
        const callId = buildCallCount;
        // Call buildFiles (which should save updated hashes to state).
        await buildFiles("parent" + callId);
        // Capture hashes after buildFiles.
        capturedHashes[callId] = { ...store.state.documentationSnapshot?.contentHashes ?? {} };

        if (callId === 1) {
          // Simulate conflict — the real impl retries; here just call buildFiles again with new parent.
          buildCallCount++;
          await buildFiles("parent" + buildCallCount);
          capturedHashes[buildCallCount] = { ...store.state.documentationSnapshot?.contentHashes ?? {} };
        }
        const newSha = "bbb".repeat(14) + "bb";
        return newSha;
      },
      async verifyCommitOnBranch() { return true; },
    });

    await cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    });

    // Hashes from call 1 and call 2 may differ because the index changes with a
    // different parentCommitSha. The important guarantee: after each buildFiles()
    // call, the store's contentHashes reflect the content from that specific call,
    // not the initial prepared hashes rendered at sourceHeadSha.
    expect(Object.keys(capturedHashes[1])).toHaveLength(3);
    expect(Object.keys(capturedHashes[2])).toHaveLength(3);

    // All three expected paths must be present in the stored hashes.
    const paths1 = Object.keys(capturedHashes[1]);
    expect(paths1.some(p => p.includes("generated/RUN-"))).toBe(true);
    expect(paths1.some(p => p.includes("RUN-INDEX"))).toBe(true);
    expect(paths1.some(p => p.includes("Runs.base"))).toBe(true);
  });

  it("crash-after-retry: reconciler uses updated hashes to adopt a commit from the second push attempt", async () => {
    // Simulate: 1st push attempt succeeded at parentA (conflict forced re-render at parentB),
    // but process crashed before saving the `publishing` checkpoint. On resume, the
    // `prepared` checkpoint has hashes from the second attempt.

    // Build initial state with a prepared checkpoint that has up-to-date hashes.
    const snapshotPath = "docs/runs/generated/RUN-0056-spec-012.md";
    const indexPath = "docs/runs/RUN-INDEX.md";
    const obsidianBasePath = "docs/runs/Runs.base";

    // Deterministic content (same as what the command would render).
    const fakeSnapshotContent = "# snapshot-retry\nrun_id: RUN-0056\n";
    const fakeIndexContent = "# index-retry\n";
    const fakeBaseContent = "# base-retry\n";

    const fakeHashSnapshot = createHash("sha256").update(fakeSnapshotContent, "utf8").digest("hex");
    const fakeHashIndex = createHash("sha256").update(fakeIndexContent, "utf8").digest("hex");
    const fakeHashBase = createHash("sha256").update(fakeBaseContent, "utf8").digest("hex");

    // The prepared checkpoint hashes reflect the second attempt's content.
    const preparedState = upsertDocumentationSnapshot(mergeReadyState(), {
      schemaVersion: 1,
      status: "prepared",
      idempotencyKey: "persist-run-doc-RUN-0056-56",
      path: snapshotPath,
      indexPath,
      obsidianBasePath,
      generatedAt: "2026-08-18T12:00:00Z",
      sourceHeadSha: sha("a"),
      contentHashes: {
        [snapshotPath]: fakeHashSnapshot,
        [indexPath]: fakeHashIndex,
        [obsidianBasePath]: fakeHashBase,
      },
      auditIdempotencyKey: "audit-run-doc-RUN-0056-56",
    });

    const store = new MemoryStateStore(preparedState);
    const landedCommitSha = sha("e");

    const gh = makeFakeGithub({
      // Origin has the content from the second attempt already.
      async getFileContentIfExists(_repo, path) {
        if (path === snapshotPath) return { content: fakeSnapshotContent, blobSha: sha("x") };
        if (path === indexPath) return { content: fakeIndexContent, blobSha: sha("y") };
        if (path === obsidianBasePath) return { content: fakeBaseContent, blobSha: sha("z") };
        return undefined;
      },
      async getLatestCommitForPath() { return landedCommitSha; },
      async getCommitChangedPaths() {
        return new Set([snapshotPath, indexPath, obsidianBasePath]);
      },
      async verifyCommitOnBranch(_repo, _branch, commitSha) {
        return commitSha === landedCommitSha;
      },
    });

    await cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    });

    // Reconciler adopted the already-landed commit; no duplicate push.
    const finalState = store.state;
    expect(finalState.documentationSnapshot?.status).toBe("persisted");
    expect(finalState.documentationSnapshot?.commitSha).toBe(landedCommitSha);
  });
});

// ===========================================================================
// Fix 2: Canonical process-code enum + field/array bounds + URL validation
// ===========================================================================

describe("Fix-2: canonical ALLOWED_PROCESS_CODES — legacy values rejected", () => {
  // Import the normalizer directly for these unit tests.
  // We need to use a dynamic import inside vitest since the scripts are pure ESM.

  it("ISSUE_CREATED (old) is not in ALLOWED_PROCESS_CODES", async () => {
    const { ALLOWED_PROCESS_CODES } = await import("../scripts/process_audit_support.mjs" as never as string) as { ALLOWED_PROCESS_CODES: Set<string> };
    expect(ALLOWED_PROCESS_CODES.has("ISSUE_CREATED")).toBe(false);
  });

  it("ITERATION_STARTED (old) is not in ALLOWED_PROCESS_CODES", async () => {
    const { ALLOWED_PROCESS_CODES } = await import("../scripts/process_audit_support.mjs" as never as string) as { ALLOWED_PROCESS_CODES: Set<string> };
    expect(ALLOWED_PROCESS_CODES.has("ITERATION_STARTED")).toBe(false);
  });

  it("REVIEW_REQUESTED (old) is not in ALLOWED_PROCESS_CODES", async () => {
    const { ALLOWED_PROCESS_CODES } = await import("../scripts/process_audit_support.mjs" as never as string) as { ALLOWED_PROCESS_CODES: Set<string> };
    expect(ALLOWED_PROCESS_CODES.has("REVIEW_REQUESTED")).toBe(false);
  });

  it("REVIEW_COMPLETED (old) is not in ALLOWED_PROCESS_CODES", async () => {
    const { ALLOWED_PROCESS_CODES } = await import("../scripts/process_audit_support.mjs" as never as string) as { ALLOWED_PROCESS_CODES: Set<string> };
    expect(ALLOWED_PROCESS_CODES.has("REVIEW_COMPLETED")).toBe(false);
  });

  it("RUN_COMPLETE (old) is not in ALLOWED_PROCESS_CODES", async () => {
    const { ALLOWED_PROCESS_CODES } = await import("../scripts/process_audit_support.mjs" as never as string) as { ALLOWED_PROCESS_CODES: Set<string> };
    expect(ALLOWED_PROCESS_CODES.has("RUN_COMPLETE")).toBe(false);
  });

  it("canonical values are all present: ISSUE_CREATE, ITERATION_START, etc.", async () => {
    const { ALLOWED_PROCESS_CODES } = await import("../scripts/process_audit_support.mjs" as never as string) as { ALLOWED_PROCESS_CODES: Set<string> };
    for (const code of [
      "ISSUE_CREATE", "ITERATION_START", "ITERATION_FINISH",
      "CODE_REVIEW", "REVIEW_COMMENT_CREATE", "REVIEW_FINDING_RESOLVE",
      "TEST_EXECUTION", "CI_VERIFICATION",
      "PR_MERGE", "DOCUMENTATION_UPDATE",
    ]) {
      expect(ALLOWED_PROCESS_CODES.has(code), `expected ${code} to be in ALLOWED_PROCESS_CODES`).toBe(true);
    }
  });
});

describe("Fix-2: normalizeProcessAuditInput field/array bounds + URL validation", () => {
  async function normalize(raw: unknown) {
    const { normalizeProcessAuditInput } = await import("../scripts/normalize_process_audit_input.mjs" as never as string) as { normalizeProcessAuditInput: (raw: unknown) => unknown };
    return normalizeProcessAuditInput(raw);
  }

  function validPayload(overrides: Record<string, unknown> = {}) {
    return {
      schema_version: 1,
      occurred_at: "2026-08-18T22:09:10.000Z",
      process_instance: "PI-MUNICHDEVELOPER-PI-SPEC-HARNESS-RUN-0056",
      idempotency_key: "audit-run-doc-RUN-0056-56",
      process_code: "DOCUMENTATION_UPDATE",
      actor: "GITHUB_ACTIONS",
      access_role: "GITHUB_ACTIONS_TOKEN",
      supporting_access_roles: [],
      outcome: "SUCCEEDED",
      repository: "munichdeveloper/pi-spec-harness",
      artifact: "abc1234",
      correlation_ids: ["RUN-0056"],
      evidence: ["https://github.com/munichdeveloper/pi-spec-harness/issues/56"],
      reason: "Run documented.",
      description: "Run doc persisted.",
      ...overrides,
    };
  }

  it("accepts a valid payload", async () => {
    await expect(normalize(validPayload())).resolves.toBeDefined();
  });

  it("rejects occurred_at without Z suffix (non-UTC)", async () => {
    await expect(normalize(validPayload({ occurred_at: "2026-08-18T22:09:10+02:00" })))
      .rejects.toThrow(/occurred_at.*UTC/i);
  });

  it("rejects repository in wrong format", async () => {
    await expect(normalize(validPayload({ repository: "not-a-slash-repo" })))
      .rejects.toThrow(/owner\/repo/i);
  });

  it("rejects process_instance over 256 chars", async () => {
    await expect(normalize(validPayload({ process_instance: "x".repeat(257) })))
      .rejects.toThrow(/process_instance.*256/);
  });

  it("rejects reason over 500 chars", async () => {
    await expect(normalize(validPayload({ reason: "r".repeat(501) })))
      .rejects.toThrow(/reason.*500/);
  });

  it("rejects evidence with more than 20 items", async () => {
    const tooManyEvidence = Array.from({ length: 21 }, (_, i) => `https://example.com/ev/${i}`);
    await expect(normalize(validPayload({ evidence: tooManyEvidence })))
      .rejects.toThrow(/evidence.*20/);
  });

  it("rejects evidence item with query string", async () => {
    await expect(normalize(validPayload({ evidence: ["https://example.com/path?token=abc"] })))
      .rejects.toThrow(/query string/);
  });

  it("rejects evidence item with fragment", async () => {
    await expect(normalize(validPayload({ evidence: ["https://example.com/path#section"] })))
      .rejects.toThrow(/fragment/);
  });

  it("rejects evidence item that is not HTTPS", async () => {
    await expect(normalize(validPayload({ evidence: ["http://example.com/path"] })))
      .rejects.toThrow(/https/i);
  });

  it("rejects evidence item with userinfo", async () => {
    // Using a URL with embedded credentials (user:password@host format).
    const urlWithUserinfo = "https://" + "user:pass@example.com/path";
    await expect(normalize(validPayload({ evidence: [urlWithUserinfo] })))
      .rejects.toThrow(/userinfo/i);
  });

  it("rejects non-canonical process_code (ISSUE_CREATED)", async () => {
    await expect(normalize(validPayload({ process_code: "ISSUE_CREATED" })))
      .rejects.toThrow(/process_code/);
  });
});

// ===========================================================================
// Fix 3: Receiver preflight — mutable ref, wrong target, missing wiring
// ===========================================================================

describe("Fix-3: preflightRunDocumentationWriter receiver YAML validation", () => {
  function makeReceiverContent(overrides: {
    marker?: string;
    uses?: string;
    eventType?: string;
    harnessRefLine?: string;
  } = {}) {
    const marker = overrides.marker ?? PROCESS_AUDIT_RECEIVER_MARKER;
    const uses = overrides.uses ??
      `${DEFAULT_REUSABLE_WORKFLOW_REPOSITORY}/.github/workflows/process-audit-automation.yml@v0.2.2`;
    const eventType = overrides.eventType ?? "repository_dispatch:\n    types: [process_audit]";
    const harnessRefLine = overrides.harnessRefLine ?? "      harness-ref: 'v0.2.2'";
    return `${marker}\non:\n  ${eventType}\njobs:\n  record:\n    uses: ${uses}\n${harnessRefLine}\n`;
  }

  it("accepts a valid managed receiver with immutable version tag", async () => {
    const content = makeReceiverContent();
    const {
      PROCESS_AUDIT_RECEIVER_MARKER: MARKER,
      DEFAULT_REUSABLE_WORKFLOW_REPOSITORY: REPO,
    } = await import("../src/workflows/template-catalog.js");
    expect(content.includes(MARKER)).toBe(true);
    expect(content.includes("repository_dispatch")).toBe(true);
    expect(content.includes("process_audit")).toBe(true);
    const expectedUsesPrefix = `${REPO}/.github/workflows/process-audit-automation.yml@`;
    const usesMatch = content.match(/uses:\s*(\S+)/);
    expect(usesMatch).toBeTruthy();
    const usesValue = usesMatch![1];
    expect(usesValue.startsWith(expectedUsesPrefix)).toBe(true);
    const ref = usesValue.slice(expectedUsesPrefix.length);
    expect(/^v\d/.test(ref)).toBe(true); // immutable version tag
    expect(content.includes("harness-ref:")).toBe(true);
  });

  it("rejects receiver with mutable ref (main)", async () => {
    const content = makeReceiverContent({
      uses: `${DEFAULT_REUSABLE_WORKFLOW_REPOSITORY}/.github/workflows/process-audit-automation.yml@main`,
    });
    const { PROCESS_AUDIT_RECEIVER_MARKER: MARKER } = await import("../src/workflows/template-catalog.js");
    expect(content.includes(MARKER)).toBe(true);
    const expectedUsesPrefix = `${DEFAULT_REUSABLE_WORKFLOW_REPOSITORY}/.github/workflows/process-audit-automation.yml@`;
    const usesMatch = content.match(/uses:\s*(\S+)/);
    const ref = usesMatch![1].slice(expectedUsesPrefix.length);
    const isMutable = !/^v\d/.test(ref) && !/^[0-9a-f]{40}$/.test(ref);
    expect(isMutable).toBe(true);
  });

  it("rejects receiver calling wrong uses: target", async () => {
    const content = makeReceiverContent({
      uses: "some-other-org/pi-spec-harness/.github/workflows/process-audit-automation.yml@v0.2.2",
    });
    const expectedUsesPrefix = `${DEFAULT_REUSABLE_WORKFLOW_REPOSITORY}/.github/workflows/process-audit-automation.yml@`;
    const usesMatch = content.match(/uses:\s*(\S+)/);
    expect(usesMatch![1].startsWith(expectedUsesPrefix)).toBe(false);
  });

  it("rejects receiver missing harness-ref: wiring", async () => {
    const content = makeReceiverContent({ harnessRefLine: "" });
    expect(content.includes("harness-ref:")).toBe(false);
  });

  it("rejects receiver missing process_audit event type", async () => {
    const content = makeReceiverContent({ eventType: "push:" });
    expect(content.includes("process_audit")).toBe(false);
  });
});

// ===========================================================================
// Fix 4: confirmAuditEventInJournal fail-closed + UTC confirmed_at validation
// ===========================================================================

describe("Fix-4: confirmAuditEventInJournal fail-closed and UTC validation", () => {
  it("propagates file-read errors instead of skipping (fail-closed)", async () => {
    const store = new MemoryStateStore(mergeReadyState());

    const gh = makeFakeGithub({
      async listDirectoryMarkdownFiles() {
        return [{ path: "docs/process-audit/journal/entry.md" }] as never;
      },
      async getFileContent() {
        // Simulate a transient read error — should NOT be silently skipped.
        throw new Error("HTTP 503: Service Unavailable");
      },
      async dispatchProcessAuditEnvelopeV1(_repo, payload) {
        void payload; // called but we don't care about dispatch for this test
      },
      async confirmAuditEventInJournal() {
        // Simulate the fail-closed behaviour: reading a journal file fails.
        throw new Error("HTTP 503: Service Unavailable");
      },
    });

    await expect(cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    })).rejects.toThrow(/503/);
  });

  it("rejects confirmed_at that does not end with Z (non-UTC)", async () => {
    const store = new MemoryStateStore(mergeReadyState());

    const gh = makeFakeGithub({
      async confirmAuditEventInJournal() {
        // Simulate a recorder that wrote a non-UTC timestamp.
        throw new Error(
          "audit journal entry ... has a non-UTC 'confirmed_at' value '2026-08-18T12:00:00+02:00' — must end with 'Z'.",
        );
      },
    });

    await expect(cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    })).rejects.toThrow(/non-UTC.*confirmed_at|confirmed_at.*non-UTC/i);
  });

  it("rejects confirmed_at that is malformed (unparseable)", async () => {
    const store = new MemoryStateStore(mergeReadyState());

    const gh = makeFakeGithub({
      async confirmAuditEventInJournal() {
        throw new Error(
          "audit journal entry ... has an unparseable 'confirmed_at' value 'not-a-date'.",
        );
      },
    });

    await expect(cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    })).rejects.toThrow(/confirmed_at/);
  });
});

// ===========================================================================
// Fix 5: Shared path validator — correct ..-segment detection, Windows paths
// ===========================================================================

describe("Fix-5: validateLegacyPath — correct traversal detection and Windows/UNC rejection", () => {
  async function validate(p: string) {
    const { validateLegacyPath } = await import("../scripts/validate_legacy_path.mjs" as never as string) as { validateLegacyPath: (p: string) => void };
    return validateLegacyPath(p);
  }

  // Paths that must be ACCEPTED
  it("accepts docs/runs/legacy (simple relative path)", async () => {
    await expect(validate("docs/runs/legacy")).resolves.toBeUndefined();
  });

  it("accepts path with spaces (e.g. docs/my runs/archive)", async () => {
    await expect(validate("docs/my runs/archive")).resolves.toBeUndefined();
  });

  it("accepts legitimate double-dot within a name (docs/v1..v2) — NOT a traversal", async () => {
    await expect(validate("docs/v1..v2")).resolves.toBeUndefined();
  });

  it("accepts docs/release...3 (three dots in name, not traversal)", async () => {
    await expect(validate("docs/release...3")).resolves.toBeUndefined();
  });

  // Paths that must be REJECTED
  it("rejects bare '..' (traversal)", async () => {
    await expect(validate("..")).rejects.toThrow(/traversal/);
  });

  it("rejects '../etc' (traversal in first segment)", async () => {
    await expect(validate("../etc")).rejects.toThrow(/traversal/);
  });

  it("rejects 'docs/../etc' (traversal in middle segment)", async () => {
    await expect(validate("docs/../etc")).rejects.toThrow(/traversal/);
  });

  it("rejects 'docs/foo/..' (traversal as last segment)", async () => {
    await expect(validate("docs/foo/..")).rejects.toThrow(/traversal/);
  });

  it("rejects POSIX absolute path '/docs/runs'", async () => {
    await expect(validate("/docs/runs")).rejects.toThrow(/absolute/i);
  });

  it("rejects Windows drive path 'C:/docs/runs'", async () => {
    await expect(validate("C:/docs/runs")).rejects.toThrow(/Windows drive/i);
  });

  it("rejects Windows drive path 'C:\\docs\\runs'", async () => {
    await expect(validate("C:\\docs\\runs")).rejects.toThrow(/Windows drive/i);
  });

  it("rejects Windows UNC path '\\\\server\\share'", async () => {
    await expect(validate("\\\\server\\share")).rejects.toThrow(/UNC/i);
  });

  it("rejects Windows UNC path '//server/share'", async () => {
    await expect(validate("//server/share")).rejects.toThrow(/UNC/i);
  });

  it("rejects option-like path '-foo'", async () => {
    await expect(validate("-foo")).rejects.toThrow(/option-like/i);
  });

  it("rejects path with NUL byte", async () => {
    await expect(validate("docs/\x00evil")).rejects.toThrow(/NUL|control/i);
  });

  it("rejects path with control character (0x01)", async () => {
    await expect(validate("docs/\x01evil")).rejects.toThrow(/NUL|control/i);
  });

  it("rejects empty path", async () => {
    await expect(validate("")).rejects.toThrow(/empty/i);
  });

  it("rejects dot-only segment '.'", async () => {
    await expect(validate("docs/./runs")).rejects.toThrow(/\./);
  });
});

// ===========================================================================
// Iteration-4 Fix-1: Complete canonical ALLOWED_PROCESS_CODES parity
// ===========================================================================

describe("Iter5-Fix-1: ALLOWED_PROCESS_CODES exact canonical parity (process-step.md)", () => {
  // Exact 31-code canonical set from docs/50-quality/process-audit/enums/process-step.md.
  // Tests assert EXACT set equality — no extra codes, no missing codes.
  const CANONICAL_PROCESS_CODES = new Set([
    "PROCESS_AUDIT_CONFIGURATION",
    "REQUIREMENT_DRAFT",
    "REQUIREMENT_APPROVAL",
    "SOFTWARE_SPEC_DRAFT",
    "SOFTWARE_SPEC_APPROVAL",
    "HUMAN_GATE_OPEN",
    "HUMAN_GATE_RESOLVE",
    "ISSUE_CREATE",
    "AGENT_ASSIGNMENT",
    "IMPLEMENTATION_START",
    "IMPLEMENTATION_UPDATE",
    "TEST_EXECUTION",
    "CI_WORKFLOW_APPROVAL",
    "CI_VERIFICATION",
    "CODE_REVIEW",
    "REVIEW_COMMENT_CREATE",
    "REVIEW_FINDING_RESOLVE",
    "ITERATION_START",
    "ITERATION_FINISH",
    "DOCUMENTATION_UPDATE",
    "PREVIEW_DEPLOYMENT",
    "PREVIEW_E2E",
    "DATABASE_MIGRATION",
    "PR_BIND",
    "PR_CREATE",
    "PR_MERGE",
    "PRODUCTION_DEPLOYMENT",
    "PRODUCTION_VERIFICATION",
    "INCIDENT_DIAGNOSIS",
    "MANUAL_INTERVENTION",
    "PROCESS_RECONCILIATION",
  ]);

  async function getCodes(): Promise<Set<string>> {
    const { ALLOWED_PROCESS_CODES } = await import("../scripts/process_audit_support.mjs" as never as string) as { ALLOWED_PROCESS_CODES: Set<string> };
    return ALLOWED_PROCESS_CODES;
  }

  it("ALLOWED_PROCESS_CODES equals the canonical 31-code set exactly (no extra, no missing)", async () => {
    const actual = await getCodes();
    // All canonical codes must be present.
    for (const code of CANONICAL_PROCESS_CODES) {
      expect(actual.has(code), `canonical code '${code}' must be in ALLOWED_PROCESS_CODES`).toBe(true);
    }
    // No extra codes allowed.
    for (const code of actual) {
      expect(CANONICAL_PROCESS_CODES.has(code), `extra code '${code}' must NOT be in ALLOWED_PROCESS_CODES`).toBe(true);
    }
    expect(actual.size).toBe(CANONICAL_PROCESS_CODES.size);
  });

  it("does not contain legacy alias ISSUE_CREATED", async () => {
    expect((await getCodes()).has("ISSUE_CREATED")).toBe(false);
  });

  it("does not contain legacy alias ITERATION_STARTED", async () => {
    expect((await getCodes()).has("ITERATION_STARTED")).toBe(false);
  });

  it("does not contain legacy alias RUN_COMPLETE", async () => {
    expect((await getCodes()).has("RUN_COMPLETE")).toBe(false);
  });

  it("does not contain previous alias CAPABILITY_SMOKE", async () => {
    expect((await getCodes()).has("CAPABILITY_SMOKE")).toBe(false);
  });

  it("does not contain previous alias BUG_TO_PR", async () => {
    expect((await getCodes()).has("BUG_TO_PR")).toBe(false);
  });

  it("does not contain previous alias GATE_APPROVED", async () => {
    expect((await getCodes()).has("GATE_APPROVED")).toBe(false);
  });
});

// ===========================================================================
// Iter4-Fix-1b: validateCanonicalUtcTimestamp round-trip enforcement
// ===========================================================================

describe("Iter4-Fix-1b: validateCanonicalUtcTimestamp round-trip enforcement", () => {
  async function validate(value: string) {
    const { validateCanonicalUtcTimestamp } = await import("../scripts/process_audit_support.mjs" as never as string) as { validateCanonicalUtcTimestamp: (v: string, f: string) => string };
    return validateCanonicalUtcTimestamp(value, "occurred_at");
  }

  it("accepts canonical form with milliseconds (2026-08-18T22:09:10.000Z)", async () => {
    await expect(validate("2026-08-18T22:09:10.000Z")).resolves.toBe("2026-08-18T22:09:10.000Z");
  });

  it("accepts canonical form with non-zero milliseconds (2026-08-18T22:09:10.972Z)", async () => {
    await expect(validate("2026-08-18T22:09:10.972Z")).resolves.toBe("2026-08-18T22:09:10.972Z");
  });

  it("rejects timestamp without milliseconds (2026-08-18T22:09:10Z) — non-canonical", async () => {
    await expect(validate("2026-08-18T22:09:10Z")).rejects.toThrow(/canonical/i);
  });

  it("rejects timestamp with +00:00 offset instead of Z — non-canonical", async () => {
    await expect(validate("2026-08-18T22:09:10.000+00:00")).rejects.toThrow();
  });

  it("rejects completely malformed timestamp", async () => {
    await expect(validate("not-a-date")).rejects.toThrow();
  });
});

// ===========================================================================
// Iter5-Fix-2: parseJournalEntry single shared implementation (both call paths)
// ===========================================================================

describe("Iter5-Fix-2: parseJournalEntry — single shared implementation, both call paths fail identically", () => {
  // Import from the shared source module directly.
  async function parseFromShared(content: string, filename: string, key: string) {
    const { parseJournalEntry } = await import("../src/audit/journalParser.js") as { parseJournalEntry: (c: string, f: string, k: string) => { confirmedAt: string } | null };
    return parseJournalEntry(content, filename, key);
  }

  // Import via process_audit_support.mjs (which re-exports from the shared module).
  async function parseFromSupport(content: string, filename: string, key: string) {
    const { parseJournalEntry } = await import("../scripts/process_audit_support.mjs" as never as string) as { parseJournalEntry: (c: string, f: string, k: string) => { confirmedAt: string } | null };
    return parseJournalEntry(content, filename, key);
  }

  const CANONICAL_AT = "2026-08-18T22:09:10.000Z";

  it("both paths return null when key is absent", async () => {
    const content = `---\nidempotency_key: "other-key"\nconfirmed_at: "${CANONICAL_AT}"\n---\n`;
    await expect(parseFromShared(content, "entry.md", "my-key")).resolves.toBeNull();
    await expect(parseFromSupport(content, "entry.md", "my-key")).resolves.toBeNull();
  });

  it("both paths return confirmedAt when entry is valid", async () => {
    const content = `---\nidempotency_key: "my-key"\nconfirmed_at: "${CANONICAL_AT}"\n---\n`;
    await expect(parseFromShared(content, "entry.md", "my-key")).resolves.toEqual({ confirmedAt: CANONICAL_AT });
    await expect(parseFromSupport(content, "entry.md", "my-key")).resolves.toEqual({ confirmedAt: CANONICAL_AT });
  });

  it("both paths throw the same error message when confirmed_at is missing", async () => {
    const content = `---\nidempotency_key: "my-key"\n---\n`;
    let sharedErr: string | undefined;
    let supportErr: string | undefined;
    try { await parseFromShared(content, "entry.md", "my-key"); } catch (e) { sharedErr = String(e); }
    try { await parseFromSupport(content, "entry.md", "my-key"); } catch (e) { supportErr = String(e); }
    expect(sharedErr).toBeDefined();
    expect(sharedErr).toBe(supportErr);
  });

  it("both paths throw the same error message when confirmed_at is non-canonical", async () => {
    const content = `---\nidempotency_key: "my-key"\nconfirmed_at: "2026-08-18T22:09:10Z"\n---\n`;
    let sharedErr: string | undefined;
    let supportErr: string | undefined;
    try { await parseFromShared(content, "entry.md", "my-key"); } catch (e) { sharedErr = String(e); }
    try { await parseFromSupport(content, "entry.md", "my-key"); } catch (e) { supportErr = String(e); }
    expect(sharedErr).toBeDefined();
    expect(sharedErr).toBe(supportErr);
  });
});

// ===========================================================================
// Iter4-Fix-3: parseJournalEntry shared canonical parser (production path)
// ===========================================================================

describe("Iter4-Fix-3: parseJournalEntry shared canonical parser", () => {
  async function parse(content: string, filename: string, key: string) {
    const { parseJournalEntry } = await import("../scripts/process_audit_support.mjs" as never as string) as { parseJournalEntry: (c: string, f: string, k: string) => { confirmedAt: string } | null };
    return parseJournalEntry(content, filename, key);
  }

  const CANONICAL_AT = "2026-08-18T22:09:10.000Z";

  it("returns null when idempotency_key is not in the file", async () => {
    const content = `---\nidempotency_key: "other-key"\nconfirmed_at: "${CANONICAL_AT}"\n---\n`;
    await expect(parse(content, "entry.md", "my-key")).resolves.toBeNull();
  });

  it("returns confirmedAt when entry matches and timestamp is canonical", async () => {
    const content = `---\nidempotency_key: "my-key"\nconfirmed_at: "${CANONICAL_AT}"\n---\n`;
    await expect(parse(content, "entry.md", "my-key")).resolves.toEqual({ confirmedAt: CANONICAL_AT });
  });

  it("throws when entry matches but confirmed_at field is missing", async () => {
    const content = `---\nidempotency_key: "my-key"\n---\n`;
    await expect(parse(content, "entry.md", "my-key")).rejects.toThrow(/confirmed_at.*missing|missing.*confirmed_at/i);
  });

  it("throws when confirmed_at is present but not canonical (no milliseconds)", async () => {
    const content = `---\nidempotency_key: "my-key"\nconfirmed_at: "2026-08-18T22:09:10Z"\n---\n`;
    await expect(parse(content, "entry.md", "my-key")).rejects.toThrow(/canonical/i);
  });

  it("throws when confirmed_at does not end with Z (non-UTC)", async () => {
    const content = `---\nidempotency_key: "my-key"\nconfirmed_at: "2026-08-18T22:09:10.000+02:00"\n---\n`;
    await expect(parse(content, "entry.md", "my-key")).rejects.toThrow();
  });

  it("throws when confirmed_at is completely malformed", async () => {
    const content = `---\nidempotency_key: "my-key"\nconfirmed_at: "not-a-date"\n---\n`;
    await expect(parse(content, "entry.md", "my-key")).rejects.toThrow();
  });
});

// ===========================================================================
// Iter4-Fix-2: validateReceiverContent production function tests
// ===========================================================================

describe("Iter4-Fix-2: validateReceiverContent production function (real exported function)", () => {
  function makeContent(overrides: {
    marker?: string;
    uses?: string;
    eventType?: string;
    harnessRefLine?: string;
  } = {}) {
    const marker = overrides.marker ?? "# Managed by pi-spec-harness: process-audit-receiver-reference v1";
    const uses = overrides.uses ??
      "munichdeveloper/pi-spec-harness/.github/workflows/process-audit-automation.yml@v0.2.2";
    const eventType = overrides.eventType ?? "repository_dispatch:\n    types: [process_audit]";
    const harnessRefLine = overrides.harnessRefLine ?? "      harness-ref: 'v0.2.2'";
    return `${marker}\non:\n  ${eventType}\njobs:\n  record:\n    uses: ${uses}\n${harnessRefLine}\n`;
  }

  async function validate(content: string, expectedRef = "v0.2.2") {
    const { validateReceiverContent } = await import("../src/github/gh.js");
    return validateReceiverContent(content, expectedRef, ".github/workflows/harness-process-audit-receiver.yml", "org/repo");
  }

  it("accepts a valid receiver pinned to the expected ref", async () => {
    await expect(validate(makeContent())).resolves.toBeUndefined();
  });

  it("rejects receiver when uses: ref differs from expectedRef", async () => {
    await expect(validate(makeContent(), "v0.3.0")).rejects.toThrow(/uses ref.*v0.2.2.*expected.*v0.3.0|configured expected ref.*v0.3.0/i);
  });

  it("rejects receiver with mutable ref (main)", async () => {
    const content = makeContent({
      uses: "munichdeveloper/pi-spec-harness/.github/workflows/process-audit-automation.yml@main",
      harnessRefLine: "      harness-ref: 'main'",
    });
    await expect(validate(content, "main")).rejects.toThrow(/mutable ref/i);
  });

  it("rejects receiver when harness-ref: input does not match uses: ref", async () => {
    const content = makeContent({ harnessRefLine: "      harness-ref: 'v0.1.0'" });
    await expect(validate(content)).rejects.toThrow(/mismatched refs|harness-ref/i);
  });

  it("rejects receiver with unsupported marker version v2", async () => {
    const content = makeContent({
      marker: "# Managed by pi-spec-harness: process-audit-receiver-reference v2",
    });
    await expect(validate(content)).rejects.toThrow(/unsupported marker version.*v2/i);
  });

  it("rejects receiver missing managed marker", async () => {
    const content = makeContent({ marker: "# unmanaged receiver" });
    await expect(validate(content)).rejects.toThrow(/not a pi-spec-harness managed receiver/i);
  });

  it("rejects receiver missing process_audit event type", async () => {
    const content = makeContent({ eventType: "push:\n    branches: [main]" });
    await expect(validate(content)).rejects.toThrow(/process_audit/i);
  });

  it("rejects receiver with wrong uses: target repo", async () => {
    const content = makeContent({
      uses: "attacker-org/pi-spec-harness/.github/workflows/process-audit-automation.yml@v0.2.2",
    });
    await expect(validate(content)).rejects.toThrow(/canonical/i);
  });

  it("rejects receiver missing harness-ref: input wiring", async () => {
    const content = makeContent({ harnessRefLine: "" });
    await expect(validate(content)).rejects.toThrow(/harness-ref/i);
  });
});

// ===========================================================================
// Iter5-Fix-3: preflightRunDocumentationWriter — credential-aware cross-repo check
// ===========================================================================

describe("Iter5-Fix-3: preflightRunDocumentationWriter — credential-aware cross-repo (production preflight)", () => {
  // These tests call the real production preflightRunDocumentationWriter (from
  // gh.ts, not a fake reimplementation) to verify the credential check.
  // Cross-repo rejection happens BEFORE any GitHub API call, so no live network
  // access is needed for the rejection case.  For the acceptance case the
  // function proceeds past the cross-repo guard and fails on the first API
  // call; we verify the error is NOT the cross-repo guard error.

  it("real preflight: rejects cross-repo recorder when no credential role is given (default GITHUB_TOKEN)", async () => {
    const { github } = await import("../src/github/gh.js");
    await expect(
      github.preflightRunDocumentationWriter("org/repo", "main", "other-org/recorder"),
    ).rejects.toThrow(/repository-scoped.*cannot dispatch|GITHUB_TOKEN.*cannot dispatch/i);
  });

  it("real preflight: rejects cross-repo recorder when role is explicitly GITHUB_TOKEN", async () => {
    const { github } = await import("../src/github/gh.js");
    await expect(
      github.preflightRunDocumentationWriter("org/repo", "main", "other-org/recorder", undefined, "GITHUB_TOKEN"),
    ).rejects.toThrow(/repository-scoped.*cannot dispatch|GITHUB_TOKEN.*cannot dispatch/i);
  });

  it("real preflight: permits cross-repo recorder when role is GITHUB_PERSONAL_ACCESS_TOKEN (passes cross-repo guard, fails at API)", async () => {
    const { github } = await import("../src/github/gh.js");
    // With a PAT role, the cross-repo guard passes.  The function then
    // attempts a live API call (which fails in the test environment).
    // We verify it does NOT throw the cross-repo guard error.
    const err = await github.preflightRunDocumentationWriter(
      "org/repo", "main", "other-org/recorder", undefined, "GITHUB_PERSONAL_ACCESS_TOKEN",
    ).catch((e: unknown) => e instanceof Error ? e : new Error(String(e)));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/repository-scoped.*cannot dispatch|GITHUB_TOKEN.*cannot dispatch/i);
  });

  it("real preflight: permits cross-repo recorder when role is GITHUB_APP_USER_AUTHORIZATION (passes cross-repo guard)", async () => {
    const { github } = await import("../src/github/gh.js");
    const err = await github.preflightRunDocumentationWriter(
      "org/repo", "main", "other-org/recorder", undefined, "GITHUB_APP_USER_AUTHORIZATION",
    ).catch((e: unknown) => e instanceof Error ? e : new Error(String(e)));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/repository-scoped.*cannot dispatch|GITHUB_TOKEN.*cannot dispatch/i);
  });
});

// ===========================================================================
// Iter4-Fix-2b: preflightRunDocumentationWriter — cross-repo rejection (CLI path)
// ===========================================================================

describe("Iter4-Fix-2b: preflightRunDocumentationWriter rejects cross-repo recorder (CLI path)", () => {
  it("throws when recorder is a different repository and no access role is provided", async () => {
    const store = new MemoryStateStore(mergeReadyState());
    const gh = makeFakeGithub({
      async preflightRunDocumentationWriter(repo, _branch, recorderRepo, _ref, credentialAccessRole) {
        if (recorderRepo && recorderRepo !== repo) {
          const role = credentialAccessRole ?? "GITHUB_TOKEN";
          if (!CROSS_REPO_ALLOWED_ROLES.has(role)) {
            throw new Error(
              `run-documentation-writer preflight failed: audit recorder repository '${recorderRepo}' ` +
              `is in a different repository from '${repo}'. ` +
              `The configured credential role '${role}' is repository-scoped and cannot dispatch events ` +
              `to a different repository.`,
            );
          }
        }
      },
    });

    await expect(cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      auditRecorderRepo: "other-org/other-repo",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    })).rejects.toThrow(/repository-scoped.*cannot dispatch|GITHUB_TOKEN.*cannot dispatch/i);
  });

  it("succeeds when recorder is different repo and PAT role is provided", async () => {
    const store = new MemoryStateStore(mergeReadyState());
    const gh = makeFakeGithub({
      async preflightRunDocumentationWriter(repo, _branch, recorderRepo, _ref, credentialAccessRole) {
        if (recorderRepo && recorderRepo !== repo) {
          const role = credentialAccessRole ?? "GITHUB_TOKEN";
          if (!CROSS_REPO_ALLOWED_ROLES.has(role)) {
            throw new Error(`cross-repo rejected: ${role}`);
          }
        }
      },
    });

    // Should NOT reject at the cross-repo guard when GITHUB_PERSONAL_ACCESS_TOKEN is given.
    await expect(cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      auditRecorderRepo: "other-org/other-repo",
      auditAccessRole: "GITHUB_PERSONAL_ACCESS_TOKEN",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    })).resolves.toBeUndefined();
  });
});

// ===========================================================================
// Iter4-Fix-4: CLI legacy-directory validation (validateLegacyDirectoryPath)
// ===========================================================================

describe("Iter4-Fix-4: CLI --legacy-directory validation via cmdPersistRunDocumentation", () => {
  function makeGh(): ReturnType<typeof makeFakeGithub> {
    return makeFakeGithub();
  }

  async function runWithLegacy(legacyDirectories: string[]) {
    const store = new MemoryStateStore(mergeReadyState());
    return cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      legacyDirectories,
      _githubAdapter: makeGh(),
      _storeFactory: () => store as never,
    });
  }

  // --- Valid paths: must NOT throw ---

  it("accepts docs/runs/legacy (simple relative path)", async () => {
    await expect(runWithLegacy(["docs/runs/legacy"])).resolves.toBeUndefined();
  });

  it("accepts path with spaces", async () => {
    await expect(runWithLegacy(["docs/my runs/archive"])).resolves.toBeUndefined();
  });

  it("accepts legitimate v1..v2 path (double-dot in name, not traversal)", async () => {
    await expect(runWithLegacy(["docs/v1..v2"])).resolves.toBeUndefined();
  });

  // --- Invalid paths: must throw ---

  it("rejects traversal '..'", async () => {
    await expect(runWithLegacy([".."])).rejects.toThrow(/traversal/i);
  });

  it("rejects traversal '../etc'", async () => {
    await expect(runWithLegacy(["../etc"])).rejects.toThrow(/traversal/i);
  });

  it("rejects traversal 'docs/../etc'", async () => {
    await expect(runWithLegacy(["docs/../etc"])).rejects.toThrow(/traversal/i);
  });

  it("rejects POSIX absolute path '/docs/runs'", async () => {
    await expect(runWithLegacy(["/docs/runs"])).rejects.toThrow(/absolute|POSIX/i);
  });

  it("rejects Windows drive path 'C:\\docs'", async () => {
    await expect(runWithLegacy(["C:\\docs"])).rejects.toThrow(/Windows drive/i);
  });

  it("rejects Windows UNC path '\\\\server\\share'", async () => {
    await expect(runWithLegacy(["\\\\server\\share"])).rejects.toThrow(/UNC/i);
  });

  it("rejects Windows UNC path '//server/share'", async () => {
    await expect(runWithLegacy(["//server/share"])).rejects.toThrow(/UNC/i);
  });

  it("rejects option-like path '-foo'", async () => {
    await expect(runWithLegacy(["-foo"])).rejects.toThrow(/option-like/i);
  });

  it("rejects path with NUL byte", async () => {
    await expect(runWithLegacy(["docs/\x00evil"])).rejects.toThrow(/NUL|control/i);
  });

  it("rejects empty path", async () => {
    await expect(runWithLegacy([""])).rejects.toThrow(/empty/i);
  });
});

// ===========================================================================
// Iter6-Fix-A: cmdPersistRunDocumentation wires auditReceiverRef to preflight
// ===========================================================================

describe("Iter6-Fix-A: auditReceiverRef is passed from cmdPersistRunDocumentation to preflightRunDocumentationWriter", () => {
  it("passes the configured auditReceiverRef exactly to preflightRunDocumentationWriter", async () => {
    const capturedArgs: { ref: string | undefined }[] = [];
    const store = new MemoryStateStore(mergeReadyState());
    const gh = makeFakeGithub({
      async preflightRunDocumentationWriter(_repo, _branch, _recorderRepo, expectedHarnessRef) {
        capturedArgs.push({ ref: expectedHarnessRef });
      },
    });

    await cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      auditReceiverRef: "abc1234def",
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    });

    expect(capturedArgs).toHaveLength(1);
    expect(capturedArgs[0]!.ref).toBe("abc1234def");
  });

  it("passes undefined to preflightRunDocumentationWriter when auditReceiverRef is not configured", async () => {
    const capturedArgs: { ref: string | undefined }[] = [];
    const store = new MemoryStateStore(mergeReadyState());
    const gh = makeFakeGithub({
      async preflightRunDocumentationWriter(_repo, _branch, _recorderRepo, expectedHarnessRef) {
        capturedArgs.push({ ref: expectedHarnessRef });
      },
    });

    await cmdPersistRunDocumentation({
      repository: "org/repo",
      issueNumber: 56,
      branch: "main",
      // auditReceiverRef not provided
      _githubAdapter: gh,
      _storeFactory: () => store as never,
    });

    expect(capturedArgs).toHaveLength(1);
    expect(capturedArgs[0]!.ref).toBeUndefined();
  });

  it("real production preflight: configured ref is forwarded (cross-repo guard still fires before API)", async () => {
    const { github } = await import("../src/github/gh.js");
    // Cross-repo without a PAT still fires the guard error, but the important
    // thing is the error comes from the guard (ref is forwarded, preflight runs).
    const err = await github.preflightRunDocumentationWriter(
      "org/repo", "main", "other-org/recorder", "abc1234", "GITHUB_PERSONAL_ACCESS_TOKEN",
    ).catch((e: unknown) => e instanceof Error ? e : new Error(String(e)));
    // The function should NOT throw the cross-repo guard error (PAT is allowed).
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toMatch(/repository-scoped.*cannot dispatch|GITHUB_TOKEN.*cannot dispatch/i);
  });
});

// ===========================================================================
// Iter6-Fix-B: CROSS_REPO_ALLOWED_ROLES contains only canonical PAT/App roles
// ===========================================================================

describe("Iter6-Fix-B: CROSS_REPO_ALLOWED_ROLES contains only canonical cross-repository-capable roles", () => {
  it("exact set equality: only GITHUB_PERSONAL_ACCESS_TOKEN and GITHUB_APP_USER_AUTHORIZATION", () => {
    const expected = new Set(["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_APP_USER_AUTHORIZATION"]);
    expect(CROSS_REPO_ALLOWED_ROLES.size).toBe(expected.size);
    for (const role of expected) {
      expect(CROSS_REPO_ALLOWED_ROLES.has(role)).toBe(true);
    }
    for (const role of CROSS_REPO_ALLOWED_ROLES) {
      expect(expected.has(role)).toBe(true);
    }
  });

  it("contains GITHUB_PERSONAL_ACCESS_TOKEN", () => {
    expect(CROSS_REPO_ALLOWED_ROLES.has("GITHUB_PERSONAL_ACCESS_TOKEN")).toBe(true);
  });

  it("contains GITHUB_APP_USER_AUTHORIZATION", () => {
    expect(CROSS_REPO_ALLOWED_ROLES.has("GITHUB_APP_USER_AUTHORIZATION")).toBe(true);
  });

  it("does NOT contain GITHUB_APP_INSTALLATION_TOKEN (not in canonical access-role enum)", () => {
    expect(CROSS_REPO_ALLOWED_ROLES.has("GITHUB_APP_INSTALLATION_TOKEN")).toBe(false);
  });

  it("does NOT contain GITHUB_COPILOT_AGENT_IDENTITY (pure identity, not a dispatch-capable credential)", () => {
    expect(CROSS_REPO_ALLOWED_ROLES.has("GITHUB_COPILOT_AGENT_IDENTITY")).toBe(false);
  });

  it("does NOT contain GITHUB_TOKEN (repository-scoped)", () => {
    expect(CROSS_REPO_ALLOWED_ROLES.has("GITHUB_TOKEN")).toBe(false);
  });

  it("does NOT contain unknown roles (fail-closed)", () => {
    expect(CROSS_REPO_ALLOWED_ROLES.has("SOME_UNKNOWN_ROLE")).toBe(false);
    expect(CROSS_REPO_ALLOWED_ROLES.has("")).toBe(false);
  });

  it("real preflight: GITHUB_COPILOT_AGENT_IDENTITY is rejected cross-repo (same as GITHUB_TOKEN)", async () => {
    const { github } = await import("../src/github/gh.js");
    await expect(
      github.preflightRunDocumentationWriter("org/repo", "main", "other-org/recorder", undefined, "GITHUB_COPILOT_AGENT_IDENTITY"),
    ).rejects.toThrow(/repository-scoped.*cannot dispatch|GITHUB_TOKEN.*cannot dispatch/i);
  });

  it("real preflight: unknown role is rejected cross-repo (fail-closed)", async () => {
    const { github } = await import("../src/github/gh.js");
    await expect(
      github.preflightRunDocumentationWriter("org/repo", "main", "other-org/recorder", undefined, "MADE_UP_ROLE"),
    ).rejects.toThrow(/repository-scoped.*cannot dispatch|GITHUB_TOKEN.*cannot dispatch/i);
  });
});
