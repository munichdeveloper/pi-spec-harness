export interface WorkflowLabelDefinition {
  name: string;
  color: string;
  description: string;
}

export interface LabelProvisioningAdapter {
  ensureLabelExists(
    repository: string,
    name: string,
    options: { color: string; description: string },
  ): Promise<void>;
}

export const DEFAULT_APPROVAL_TRIGGER_LABEL = "harness:approved-for-agent";
export const DEFAULT_APPROVAL_TARGET_LABELS = ["status:ready", "ai:allowed", "harness:implementation"] as const;

const KNOWN_LABELS: Record<string, Omit<WorkflowLabelDefinition, "name">> = {
  [DEFAULT_APPROVAL_TRIGGER_LABEL]: {
    color: "0E8A16",
    description: "Human approval that starts the configured implementation workflow",
  },
  "status:ready": { color: "0E8A16", description: "Ready for implementation" },
  "ai:allowed": { color: "7057FF", description: "An AI coding agent may work on this issue" },
  "harness:implementation": { color: "5319E7", description: "Implementation issue managed by pi-spec-harness" },
};

export function buildApprovalWorkflowLabelPlan(options: {
  triggerLabel?: string;
  targetLabels?: string[];
} = {}): WorkflowLabelDefinition[] {
  const trigger = options.triggerLabel?.trim() || DEFAULT_APPROVAL_TRIGGER_LABEL;
  const targets = options.targetLabels ?? [...DEFAULT_APPROVAL_TARGET_LABELS];
  const names = [trigger, ...targets.map((label) => label.trim())];
  if (names.some((name) => name.length === 0)) {
    throw new Error("approval workflow labels must not be empty");
  }

  const seen = new Set<string>();
  return names.flatMap((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    const known = KNOWN_LABELS[key];
    return [{
      name,
      color: known?.color ?? "5319E7",
      description: known?.description ?? "Label required by the installed pi-spec-harness approval workflow",
    }];
  });
}

export async function provisionApprovalWorkflowLabels(
  adapter: LabelProvisioningAdapter,
  repository: string,
  options: { triggerLabel?: string; targetLabels?: string[] } = {},
): Promise<WorkflowLabelDefinition[]> {
  const plan = buildApprovalWorkflowLabelPlan(options);
  try {
    for (const label of plan) {
      await adapter.ensureLabelExists(repository, label.name, label);
    }
  } catch (error) {
    throw new Error(
      `label provisioning failed for 'label-approval-bundling' in '${repository}'. ` +
      `Verify that the installation credential has issues:write permission. Cause: ${String(error)}`,
    );
  }
  return plan;
}
