import { describe, expect, it } from "vitest";
import {
  buildApprovalWorkflowLabelPlan,
  DEFAULT_APPROVAL_TARGET_LABELS,
  DEFAULT_APPROVAL_TRIGGER_LABEL,
  provisionApprovalWorkflowLabels,
} from "../src/workflows/label-provisioning.js";

describe("approval workflow label provisioning", () => {
  it("provisions the default trigger and all default target labels", () => {
    expect(buildApprovalWorkflowLabelPlan().map((label) => label.name)).toEqual([
      DEFAULT_APPROVAL_TRIGGER_LABEL,
      ...DEFAULT_APPROVAL_TARGET_LABELS,
    ]);
  });

  it("uses custom trigger and target labels", () => {
    expect(buildApprovalWorkflowLabelPlan({
      triggerLabel: "product:approved",
      targetLabels: ["delivery:ready", "agent:allowed"],
    }).map((label) => label.name)).toEqual(["product:approved", "delivery:ready", "agent:allowed"]);
  });

  it("deduplicates labels case-insensitively while preserving first spelling", () => {
    expect(buildApprovalWorkflowLabelPlan({
      triggerLabel: "Ready",
      targetLabels: ["ready", "READY", "ship"],
    }).map((label) => label.name)).toEqual(["Ready", "ship"]);
  });

  it("rejects empty custom target labels before any GitHub write", () => {
    expect(() => buildApprovalWorkflowLabelPlan({ targetLabels: ["status:ready", "  "] })).toThrow(/must not be empty/);
  });

  it("creates every missing label and repeated installation is an effective no-op", async () => {
    const labels = new Set<string>();
    let created = 0;
    const adapter = {
      async ensureLabelExists(_repository: string, name: string) {
        if (!labels.has(name.toLowerCase())) {
          labels.add(name.toLowerCase());
          created += 1;
        }
      },
    };
    await provisionApprovalWorkflowLabels(adapter, "owner/empty-repo");
    expect(created).toBe(4);
    await provisionApprovalWorkflowLabels(adapter, "owner/empty-repo");
    expect(created).toBe(4);
  });

  it("surfaces a concrete capability error before workflow activation", async () => {
    const adapter = {
      async ensureLabelExists() { throw new Error("HTTP 403"); },
    };
    await expect(provisionApprovalWorkflowLabels(adapter, "owner/repo")).rejects.toThrow(/issues:write.*HTTP 403/);
  });
});
