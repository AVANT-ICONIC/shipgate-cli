import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VerificationResult } from "../config/schema.js";

function rel(projectRoot: string, target: string): string {
  return path.relative(projectRoot, target) || target;
}

export async function writeRepairPrompt(result: VerificationResult): Promise<string | undefined> {
  const promptPath = path.join(result.projectRoot, ".shipgate", "latest-repair-prompt.md");
  if (result.status !== "failed") {
    await rm(promptPath, { force: true });
    return undefined;
  }

  await mkdir(path.dirname(promptPath), { recursive: true });

  const failedSteps = result.steps.filter((step) => step.status === "failed");

  const lines: string[] = [];
  lines.push("# ShipGate Repair Prompt");
  lines.push("");
  lines.push("You are fixing a project that failed ShipGate verification.");
  lines.push("");
  lines.push("Rules:");
  lines.push("");
  lines.push("1. Fix the root cause, not the report.");
  lines.push("2. Do not delete or weaken ShipGate checks to create a fake pass.");
  lines.push("3. Do not rewrite unrelated code.");
  lines.push("4. Rerun `shipgate verify --fresh` before claiming completion.");
  lines.push("5. If the verification contract itself is wrong, explain the proposed contract change explicitly.");
  lines.push("");
  lines.push("## Failure Summary");
  lines.push("");
  for (const step of failedSteps) {
    lines.push(`### ${step.name}`);
    lines.push("");
    lines.push(`- Kind: ${step.kind}`);
    lines.push(`- Command: ${step.command ? `\`${step.command}\`` : "n/a"}`);
    lines.push(`- Exit code: ${typeof step.exitCode === "undefined" ? "n/a" : step.exitCode}`);
    if (step.kind === "policy" && step.details && typeof step.details.policyStatus === "string") {
      lines.push(`- Policy status: ${step.details.policyStatus}`);
      const findings = Array.isArray(step.details.findings) ? step.details.findings : [];
      if (findings.length) {
        lines.push("");
        lines.push(`Policy findings (${findings.length}):`);
        for (const finding of findings.slice(0, 25)) {
          const f = finding as { rule?: unknown; message?: unknown; paths?: unknown };
          const paths = Array.isArray(f.paths) ? (f.paths as unknown[]).join(", ") : "";
          lines.push(`- [${String(f.rule ?? "unknown")}] ${String(f.message ?? "")}${paths ? ` (${paths})` : ""}`);
        }
        if (findings.length > 25) lines.push(`- …and ${findings.length - 25} more`);
      }
      if (step.stdoutExcerpt) {
        lines.push("");
        lines.push("Policy output:");
        lines.push("");
        lines.push("```");
        lines.push(step.stdoutExcerpt);
        lines.push("```");
      }
    }
    if (step.error) {
      lines.push("");
      lines.push("Error:");
      lines.push("");
      lines.push("```");
      lines.push(step.error);
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
        lines.push(`- ${artifact.label}: \`${rel(result.projectRoot, artifact.path)}\``);
      }
    }
    lines.push("");
  }

  lines.push("## Required Outcome");
  lines.push("");
  lines.push("Make this command pass:");
  lines.push("");
  lines.push("```bash");
  lines.push("shipgate verify --fresh");
  lines.push("```");
  lines.push("");

  await writeFile(promptPath, lines.join("\n"), "utf8");
  return promptPath;
}
