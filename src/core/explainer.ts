import path from "node:path";
import type {
  ArtifactRef,
  StepResult,
  StepStatus,
  VerificationResult
} from "../config/schema.js";

const STEP_STATUSES: StepStatus[] = ["passed", "failed", "skipped"];

export type ExplainedStep = {
  id: string;
  name: string;
  kind: StepResult["kind"];
  status: StepResult["status"];
  required: boolean;
  command?: string;
  exitCode?: number | null;
  error?: string;
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
  artifacts: ArtifactRef[];
};

export type VerificationExplanation = {
  status: VerificationResult["status"];
  reason: string;
  fresh: boolean;
  profile: string;
  packageManager: string;
  projectRoot: string;
  verificationRoot: string;
  workspaceRoot?: string;
  verificationWorkspaceRoot?: string;
  reportPath: string;
  repairPromptPath?: string;
  stepCounts: Record<StepStatus, number>;
  failedSteps: ExplainedStep[];
  nextActions: string[];
};

function rel(projectRoot: string, target: string): string {
  return path.relative(projectRoot, target) || target;
}

function firstLine(value: string): string {
  return value.split("\n").find((line) => line.trim().length > 0)?.trim() ?? value.trim();
}

function countSteps(steps: StepResult[]): Record<StepStatus, number> {
  const counts = Object.fromEntries(STEP_STATUSES.map((status) => [status, 0])) as Record<StepStatus, number>;
  for (const step of steps) counts[step.status] += 1;
  return counts;
}

function explainStep(step: StepResult): ExplainedStep {
  return {
    id: step.id,
    name: step.name,
    kind: step.kind,
    status: step.status,
    required: step.required,
    command: step.command,
    exitCode: step.exitCode,
    error: step.error,
    stdoutExcerpt: step.stdoutExcerpt,
    stderrExcerpt: step.stderrExcerpt,
    artifacts: step.artifacts ?? []
  };
}

function failureReason(failedSteps: StepResult[]): string {
  const firstFailure = failedSteps.find((step) => step.required) ?? failedSteps[0];
  if (!firstFailure) return "Verification failed, but no failed step was recorded.";

  const base = firstFailure.required
    ? `Required step "${firstFailure.name}" failed.`
    : `Step "${firstFailure.name}" failed.`;
  const detail = firstFailure.error ?? firstFailure.stderrExcerpt ?? firstFailure.stdoutExcerpt;

  if (detail) return `${base} ${firstLine(detail)}`;
  if (typeof firstFailure.exitCode !== "undefined") return `${base} Exit code: ${firstFailure.exitCode}.`;
  return base;
}

function nextActions(result: VerificationResult, failedSteps: StepResult[]): string[] {
  if (result.status === "passed") {
    return [
      "No repair prompt is expected for a passing verification.",
      `Use the report at ${rel(result.projectRoot, result.reportPath)} as verification evidence.`
    ];
  }

  const firstFailure = failedSteps.find((step) => step.required) ?? failedSteps[0];
  const actions = [
    firstFailure
      ? `Fix "${firstFailure.name}" first; it is the first failing ${firstFailure.required ? "required" : "recorded"} step.`
      : "Inspect the report to identify the failing verification step."
  ];

  if (firstFailure?.command) actions.push(`Inspect or rerun this command: ${firstFailure.command}`);
  if (firstFailure?.artifacts?.length) {
    actions.push(`Inspect artifacts: ${firstFailure.artifacts.map((artifact) => rel(result.projectRoot, artifact.path)).join(", ")}`);
  }

  actions.push(`Read the full report at ${rel(result.projectRoot, result.reportPath)}.`);
  if (result.repairPromptPath) {
    actions.push(`Use the repair prompt at ${rel(result.projectRoot, result.repairPromptPath)} for a handoff.`);
  }
  actions.push("Do not remove or weaken ShipGate checks unless the verification contract is intentionally changing.");
  actions.push("Rerun `shipgate verify --fresh` after fixing the root cause.");

  return actions;
}

export function createVerificationExplanation(result: VerificationResult): VerificationExplanation {
  const failedSteps = result.steps.filter((step) => step.status === "failed");

  return {
    status: result.status,
    reason: result.status === "passed"
      ? "All required verification steps passed."
      : failureReason(failedSteps),
    fresh: result.fresh,
    profile: result.profile,
    packageManager: result.packageManager,
    projectRoot: result.projectRoot,
    verificationRoot: result.verificationRoot,
    workspaceRoot: result.workspaceRoot,
    verificationWorkspaceRoot: result.verificationWorkspaceRoot,
    reportPath: result.reportPath,
    repairPromptPath: result.repairPromptPath,
    stepCounts: countSteps(result.steps),
    failedSteps: failedSteps.map(explainStep),
    nextActions: nextActions(result, failedSteps)
  };
}

function pushOptionalBlock(lines: string[], title: string, value: string | undefined): void {
  if (!value) return;
  lines.push("");
  lines.push(`${title}:`);
  lines.push("");
  lines.push("```");
  lines.push(value);
  lines.push("```");
}

export function formatVerificationExplanation(result: VerificationResult): string {
  const explanation = createVerificationExplanation(result);
  const lines: string[] = [];

  lines.push("# ShipGate Explanation");
  lines.push("");
  lines.push(`Status: **${explanation.status.toUpperCase()}**`);
  lines.push(`Reason: ${explanation.reason}`);
  lines.push(`Fresh mode: **${explanation.fresh ? "true" : "false"}**`);
  lines.push(`Profile: \`${explanation.profile}\``);
  lines.push(`Package manager: \`${explanation.packageManager}\``);
  lines.push(`Report: \`${rel(explanation.projectRoot, explanation.reportPath)}\``);
  if (explanation.repairPromptPath) {
    lines.push(`Repair prompt: \`${rel(explanation.projectRoot, explanation.repairPromptPath)}\``);
  }
  lines.push("");
  lines.push("## Step Counts");
  lines.push("");
  lines.push(`- Passed: ${explanation.stepCounts.passed}`);
  lines.push(`- Failed: ${explanation.stepCounts.failed}`);
  lines.push(`- Skipped: ${explanation.stepCounts.skipped}`);
  lines.push("");
  lines.push("## Failed Steps");
  lines.push("");

  if (!explanation.failedSteps.length) {
    lines.push("No failed steps.");
  } else {
    for (const step of explanation.failedSteps) {
      lines.push(`### ${step.name}`);
      lines.push("");
      lines.push(`- Kind: ${step.kind}`);
      lines.push(`- Required: ${step.required}`);
      if (step.command) lines.push(`- Command: \`${step.command}\``);
      if (typeof step.exitCode !== "undefined") lines.push(`- Exit code: ${step.exitCode}`);
      pushOptionalBlock(lines, "Error", step.error);
      pushOptionalBlock(lines, "Stdout excerpt", step.stdoutExcerpt);
      pushOptionalBlock(lines, "Stderr excerpt", step.stderrExcerpt);
      if (step.artifacts.length) {
        lines.push("");
        lines.push("Artifacts:");
        for (const artifact of step.artifacts) {
          lines.push(`- ${artifact.label}: \`${rel(explanation.projectRoot, artifact.path)}\``);
        }
      }
      lines.push("");
    }
  }

  lines.push("");
  lines.push("## Next Actions");
  lines.push("");
  explanation.nextActions.forEach((action, index) => {
    lines.push(`${index + 1}. ${action}`);
  });
  lines.push("");

  return lines.join("\n");
}
