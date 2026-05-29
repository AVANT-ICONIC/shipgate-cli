import { writeFile } from "node:fs/promises";
import path from "node:path";
import { execaCommand } from "execa";
import type { CommandStepConfig, StepResult } from "../config/schema.js";
import type { ArtifactStore } from "./artifactStore.js";
import { durationMs, nowIso } from "../utils/time.js";
import { resolveLocalPath } from "../utils/pathSafety.js";

const ansiEscape = new RegExp(`${String.fromCharCode(27)}(?:\\[[0-?]*[ -/]*[@-~]|[@-_])`, "g");

function excerpt(value: string, max = 3000): string {
  const plainText = value.replace(ansiEscape, "");
  if (plainText.length <= max) return plainText;
  return `${plainText.slice(0, max)}\n... [truncated ${plainText.length - max} chars]`;
}

function outputFromError(error: unknown, stream: "stdout" | "stderr"): string {
  if (error && typeof error === "object" && stream in error) {
    const value = (error as Record<string, unknown>)[stream];
    if (typeof value === "string") return value;
  }
  return "";
}

function exitCodeFromError(error: unknown): number | null {
  if (error && typeof error === "object" && "exitCode" in error) {
    const value = (error as Record<string, unknown>).exitCode;
    if (typeof value === "number" || value === null) return value;
  }
  return 1;
}

export async function runCommandStep(
  id: string,
  step: CommandStepConfig,
  cwd: string,
  store: ArtifactStore,
  inheritedEnv: Record<string, string> = {},
  allowedCwdRoot = cwd
): Promise<StepResult & { rawStdout: string; rawStderr: string }> {
  const startedAt = nowIso();
  const start = Date.now();
  const safeId = id.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  const stdoutPath = path.join(store.commandLogsDir, `${safeId}.stdout.log`);
  const stderrPath = path.join(store.commandLogsDir, `${safeId}.stderr.log`);

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let errorMessage: string | undefined;
  let resolvedCwd = cwd;

  if (store.logsEnabled) {
    await writeFile(stdoutPath, "", "utf8");
    await writeFile(stderrPath, "", "utf8");
  }

  try {
    resolvedCwd = step.cwd
      ? resolveLocalPath(cwd, step.cwd, `${step.name} cwd`, allowedCwdRoot)
      : cwd;
    const child = execaCommand(step.command, {
      cwd: resolvedCwd,
      shell: true,
      reject: false,
      timeout: step.timeoutMs ?? 120000,
      env: {
        ...process.env,
        ...inheritedEnv,
        ...(step.env ?? {})
      }
    });

    const result = await child;
    exitCode = result.exitCode ?? null;
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
    if ("timedOut" in result && result.timedOut === true) {
      errorMessage = `Command timed out after ${step.timeoutMs ?? 120000}ms.`;
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    exitCode = exitCodeFromError(error);
    stdout = outputFromError(error, "stdout");
    stderr = outputFromError(error, "stderr");
  }

  if (store.logsEnabled) {
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
  }

  const status = exitCode === 0 && !errorMessage ? "passed" : "failed";

  return {
    id,
    name: step.name,
    kind: "command",
    status,
    required: step.required ?? true,
    startedAt,
    endedAt: nowIso(),
    durationMs: durationMs(start),
    command: step.command,
    cwd: resolvedCwd,
    exitCode,
    stdoutExcerpt: excerpt(stdout),
    stderrExcerpt: excerpt(stderr),
    error: errorMessage,
    artifacts: store.logsEnabled ? [
      { kind: "log", label: `${step.name} stdout`, path: stdoutPath },
      { kind: "log", label: `${step.name} stderr`, path: stderrPath }
    ] : [],
    rawStdout: stdout,
    rawStderr: stderr
  };
}

export function stripRawCommandOutput(
  result: StepResult & { rawStdout: string; rawStderr: string }
): StepResult {
  const copy = { ...result } as StepResult & Partial<{ rawStdout: string; rawStderr: string }>;
  delete copy.rawStdout;
  delete copy.rawStderr;
  return copy;
}
