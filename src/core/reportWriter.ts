import { mkdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import type { StepResult, VerificationResult } from "../config/schema.js";

function rel(projectRoot: string, target: string): string {
  return path.relative(projectRoot, target) || target;
}

function statusIcon(status: string): string {
  return status === "passed" ? "✅" : status === "failed" ? "🔥" : "⏭️";
}

function formatStep(projectRoot: string, step: StepResult): string {
  const lines: string[] = [];
  lines.push(`### ${statusIcon(step.status)} ${step.name}`);
  lines.push("");
  lines.push(`- Kind: ${step.kind}`);
  lines.push(`- Status: ${step.status}`);
  lines.push(`- Required: ${step.required}`);
  lines.push(`- Duration: ${step.durationMs}ms`);
  if (step.command) lines.push(`- Command: \`${step.command}\``);
  if (typeof step.exitCode !== "undefined") lines.push(`- Exit code: ${step.exitCode}`);
  if (step.error) {
    lines.push("");
    lines.push("Error:");
    lines.push("");
    lines.push("```");
    lines.push(step.error);
    lines.push("```");
  }
  if (step.stdoutExcerpt) {
    lines.push("");
    lines.push("Stdout excerpt:");
    lines.push("");
    lines.push("```");
    lines.push(step.stdoutExcerpt);
    lines.push("```");
  }
  if (step.stderrExcerpt) {
    lines.push("");
    lines.push("Stderr excerpt:");
    lines.push("");
    lines.push("```");
    lines.push(step.stderrExcerpt);
    lines.push("```");
  }
  if (step.artifacts?.length) {
    lines.push("");
    lines.push("Artifacts:");
    for (const artifact of step.artifacts) {
      lines.push(`- ${artifact.label}: \`${rel(projectRoot, artifact.path)}\``);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeReport(result: VerificationResult): Promise<string> {
  await mkdir(path.dirname(result.reportPath), { recursive: true });

  const failedSteps = result.steps.filter((step) => step.status === "failed");
  const lines: string[] = [];

  lines.push("# ShipGate Verification Report");
  lines.push("");
  lines.push(`Status: **${result.status.toUpperCase()}**`);
  lines.push(`Fresh mode: **${result.fresh ? "true" : "false"}**`);
  lines.push(`Profile: \`${result.profile}\``);
  lines.push(`Package manager: \`${result.packageManager}\``);
  lines.push(`Project root: \`${result.projectRoot}\``);
  if (result.workspaceRoot) lines.push(`Workspace root: \`${result.workspaceRoot}\``);
  lines.push(`Verification root: \`${result.verificationRoot}\``);
  if (result.verificationWorkspaceRoot) {
    lines.push(`Verification workspace root: \`${result.verificationWorkspaceRoot}\``);
  }
  lines.push(`Started: ${result.startedAt}`);
  lines.push(`Ended: ${result.endedAt}`);
  lines.push(`Duration: ${result.durationMs}ms`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Step | Kind | Status | Duration |");
  lines.push("| --- | --- | --- | ---: |");
  for (const step of result.steps) {
    lines.push(`| ${step.name} | ${step.kind} | ${statusIcon(step.status)} ${step.status} | ${step.durationMs}ms |`);
  }
  lines.push("");

  if (failedSteps.length) {
    lines.push("## Failure Summary");
    lines.push("");
    for (const step of failedSteps) {
      lines.push(`- **${step.name}** failed: ${step.error ? step.error.split("\n")[0] : "see details below"}`);
    }
    lines.push("");
  }

  lines.push("## Step Details");
  lines.push("");
  for (const step of result.steps) {
    lines.push(formatStep(result.projectRoot, step));
  }

  lines.push("## Artifact Index");
  lines.push("");
  const allArtifacts = [
    ...result.artifacts,
    ...result.steps.flatMap((step) => step.artifacts ?? [])
  ];
  if (!allArtifacts.length) {
    lines.push("No artifacts captured.");
  } else {
    for (const artifact of allArtifacts) {
      lines.push(`- ${artifact.kind}: ${artifact.label} — \`${rel(result.projectRoot, artifact.path)}\``);
    }
  }
  lines.push("");

  const content = lines.join("\n");
  await writeFile(result.reportPath, content, "utf8");
  await copyFile(result.reportPath, path.join(result.projectRoot, ".shipgate", "latest-report.md"));

  return result.reportPath;
}
