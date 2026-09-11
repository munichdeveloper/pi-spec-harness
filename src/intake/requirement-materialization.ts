import { assertHygiene } from "../state/hygiene.js";

export const REQUIREMENT_MATERIALIZATION_MARKER = "pi-spec-harness:requirement-materialization:v1";

export interface ApprovedRequirementIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: { name: string }[];
  comments?: { body: string }[];
}

export interface RequirementMaterializationPlan {
  requirementId: string;
  requirementPath: string;
  branch: string;
  title: string;
  content: string;
  pullRequestTitle: string;
  pullRequestBody: string;
}

export function isApprovedRequirement(issue: ApprovedRequirementIssue): boolean {
  const labels = new Set(issue.labels.map((label) => label.name));
  return labels.has("type:requirement") && labels.has("harness:approved-for-agent");
}

export function buildRequirementMaterializationPlan(
  issue: ApprovedRequirementIssue,
  outputDirectory = "docs/requirements",
): RequirementMaterializationPlan {
  if (!Number.isSafeInteger(issue.number) || issue.number <= 0) {
    throw new Error("requirement materialization requires a positive issue number");
  }
  if (!isApprovedRequirement(issue)) {
    throw new Error(`issue #${issue.number} is not an approved type:requirement`);
  }
  const pathSegments = outputDirectory.split("/");
  if (
    !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(outputDirectory) ||
    pathSegments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`invalid requirement output directory '${outputDirectory}'`);
  }

  const requirementId = `REQ-${String(issue.number).padStart(3, "0")}`;
  const requirementPath = `${outputDirectory}/${requirementId}.md`;
  const branch = `harness/requirement-issue-${issue.number}`;
  const normalizedTitle = issue.title.replace(/[\r\n]+/g, " ").trim();
  const body = issue.body.trim();
  const content = [
    "---",
    `id: ${requirementId}`,
    "type: requirement",
    `title: ${JSON.stringify(normalizedTitle)}`,
    "status: approved",
    `source_issue: ${issue.number}`,
    `source_url: ${issue.url}`,
    "approval: harness:approved-for-agent",
    "---",
    "",
    `# ${requirementId}: ${normalizedTitle}`,
    "",
    `<!-- ${REQUIREMENT_MATERIALIZATION_MARKER}; source-issue=${issue.number} -->`,
    "",
    body,
    "",
  ].join("\n");

  const pullRequestTitle = `${requirementId}: Materialize approved requirement from issue #${issue.number}`;
  const pullRequestBody = [
    `Materializes the already approved requirement from ${issue.url}.`,
    "",
    `- Source approval: \`harness:approved-for-agent\` on issue #${issue.number}`,
    `- Artifact: \`${requirementPath}\``,
    `- Marker: \`${REQUIREMENT_MATERIALIZATION_MARKER}\``,
    "",
    "This deterministic PR contains no product implementation. The Harness may squash-merge it only after all repository checks and protections pass; no second content approval is required.",
  ].join("\n");

  assertHygiene({ content, pullRequestTitle, pullRequestBody });
  return { requirementId, requirementPath, branch, title: normalizedTitle, content, pullRequestTitle, pullRequestBody };
}
