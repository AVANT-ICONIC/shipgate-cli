import { readFile } from "node:fs/promises";
import type { CliFlow, StepResult } from "../config/schema.js";
import type { ArtifactStore } from "../core/artifactStore.js";
import { runCommandStep } from "../core/commandRunner.js";

async function readCommandLog(result: StepResult, labelSuffix: string): Promise<string> {
  const artifact = result.artifacts?.find((candidate) => candidate.label.endsWith(labelSuffix));
  return artifact ? readFile(artifact.path, "utf8") : "";
}

export async function runCliFlow(
  flow: CliFlow,
  cwd: string,
  store: ArtifactStore,
  env: Record<string, string>
): Promise<StepResult> {
  const result = await runCommandStep(
    `cli:${flow.name}`,
    {
      name: flow.name,
      command: flow.command,
      timeoutMs: flow.timeoutMs,
      required: true
    },
    cwd,
    store,
    env
  );

  const expect = flow.expect ?? { exitCode: 0, stdoutIncludes: [], stderrIncludes: [] };
  const failures: string[] = [];
  const stdout = await readCommandLog(result, "stdout");
  const stderr = await readCommandLog(result, "stderr");

  if (result.error) {
    failures.push(result.error);
  }

  if (result.exitCode !== expect.exitCode) {
    failures.push(`Expected exit code ${expect.exitCode}, got ${result.exitCode}`);
  }

  for (const value of expect.stdoutIncludes ?? []) {
    if (!stdout.includes(value)) failures.push(`stdout missing: ${value}`);
  }

  for (const value of expect.stderrIncludes ?? []) {
    if (!stderr.includes(value)) failures.push(`stderr missing: ${value}`);
  }

  return {
    ...result,
    kind: "command",
    status: failures.length === 0 ? "passed" : "failed",
    error: failures.length ? failures.join("\n") : result.error
  };
}
