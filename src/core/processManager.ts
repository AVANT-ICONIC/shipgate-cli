import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa, execaCommand, type ResultPromise } from "execa";
import type { CommandStepConfig, ArtifactRef } from "../config/schema.js";
import type { ArtifactStore } from "./artifactStore.js";
import { resolveLocalPath } from "../utils/pathSafety.js";

export type ManagedProcess = {
  process: ResultPromise;
  stdoutPath?: string;
  stderrPath?: string;
  artifacts: ArtifactRef[];
  stop(): Promise<void>;
};

type StoppableProcess = PromiseLike<unknown> & Pick<ResultPromise, "pid" | "killed" | "kill">;

type StopProcessTreeOptions = {
  platform?: NodeJS.Platform;
  gracePeriodMs?: number;
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => unknown;
  runTaskkill?: (pid: number) => Promise<unknown>;
  delay?: (timeoutMs: number) => Promise<void>;
};

const PROCESS_STOP_GRACE_MS = 3000;
const PROCESS_STOP_POLL_MS = 50;

async function waitForProcess(child: PromiseLike<unknown>): Promise<void> {
  try {
    await child;
  } catch {
    // Process shutdown may reject when it exits on a signal.
  }
}

function isMissingProcessError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EPERM";
}

function signalPosixGroup(
  pid: number,
  signal: NodeJS.Signals | 0,
  signalProcess: (pid: number, signal: NodeJS.Signals | 0) => unknown
): boolean {
  try {
    signalProcess(-pid, signal);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) return false;
    // After SIGTERM, an inaccessible group cannot be probed or escalated by ShipGate.
    if (signal === 0 && isPermissionError(error)) return false;
    throw error;
  }
}

export async function stopProcessTree(
  child: StoppableProcess,
  options: StopProcessTreeOptions = {}
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const pid = child.pid;

  if (!pid) {
    if (!child.killed) child.kill("SIGTERM");
    await waitForProcess(child);
    return;
  }

  if (platform === "win32") {
    const runTaskkill = options.runTaskkill ?? (async (processId: number) => {
      await execa("taskkill", ["/PID", String(processId), "/T", "/F"], { reject: false });
    });
    await runTaskkill(pid);
    await waitForProcess(child);
    return;
  }

  const signalProcess = options.signalProcess ?? process.kill.bind(process);
  const delay = options.delay ?? ((timeoutMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  }));
  const gracePeriodMs = options.gracePeriodMs ?? PROCESS_STOP_GRACE_MS;

  signalPosixGroup(pid, "SIGTERM", signalProcess);

  const deadline = Date.now() + gracePeriodMs;
  let groupAlive = signalPosixGroup(pid, 0, signalProcess);
  while (groupAlive && Date.now() < deadline) {
    await delay(Math.min(PROCESS_STOP_POLL_MS, deadline - Date.now()));
    groupAlive = signalPosixGroup(pid, 0, signalProcess);
  }

  if (groupAlive) {
    signalPosixGroup(pid, "SIGKILL", signalProcess);
  }

  await waitForProcess(child);
}

export async function startManagedProcess(
  step: CommandStepConfig,
  cwd: string,
  store: ArtifactStore,
  env: Record<string, string> = {},
  allowedCwdRoot = cwd
): Promise<ManagedProcess> {
  const stdoutPath = path.join(store.commandLogsDir, "server.stdout.log");
  const stderrPath = path.join(store.commandLogsDir, "server.stderr.log");
  const resolvedCwd = step.cwd
    ? resolveLocalPath(cwd, step.cwd, `${step.name} cwd`, allowedCwdRoot)
    : cwd;

  if (store.logsEnabled) {
    await mkdir(store.commandLogsDir, { recursive: true });
    await writeFile(stdoutPath, "", "utf8");
    await writeFile(stderrPath, "", "utf8");
  }

  const child = execaCommand(step.command, {
    cwd: resolvedCwd,
    shell: true,
    reject: false,
    forceKillAfterDelay: 3000,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      ...env,
      ...(step.env ?? {})
    }
  });

  if (store.logsEnabled) {
    child.stdout?.on("data", (chunk) => {
      void appendFile(stdoutPath, chunk.toString());
    });

    child.stderr?.on("data", (chunk) => {
      void appendFile(stderrPath, chunk.toString());
    });
  }

  return {
    process: child,
    stdoutPath: store.logsEnabled ? stdoutPath : undefined,
    stderrPath: store.logsEnabled ? stderrPath : undefined,
    artifacts: store.logsEnabled ? [
      { kind: "log", label: "server stdout", path: stdoutPath },
      { kind: "log", label: "server stderr", path: stderrPath }
    ] : [],
    async stop() {
      await stopProcessTree(child);
    }
  };
}

type ProcessExitResult = {
  exitCode?: number | null;
  stderr?: unknown;
};

function earlyExitError(url: string, result: ProcessExitResult): Error {
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : "unknown";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const stderrDetails = stderr ? ` Stderr: ${stderr.slice(0, 1000)}` : "";

  return new Error(
    `Application process exited before ${url} became ready (exit code ${exitCode}).${stderrDetails}`
  );
}

export async function waitForUrl(
  url: string,
  timeoutMs: number,
  readyText?: string,
  process?: PromiseLike<ProcessExitResult>
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  let sawNonReadyResponse = false;
  const processExit = process
    ? Promise.resolve(process).then((result) => ({ type: "exit" as const, result }))
    : undefined;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, remainingMs));

    const request = fetch(url, { signal: controller.signal })
      .then(async (response) => ({
        type: "response" as const,
        response,
        body: typeof readyText === "string" && response.status < 500
          ? await response.text()
          : undefined
      }))
      .catch((error: unknown) => ({ type: "request-error" as const, error }));
    const outcome = processExit ? await Promise.race([request, processExit]) : await request;
    clearTimeout(timeout);

    if (outcome.type === "exit") {
      controller.abort();
      throw earlyExitError(url, outcome.result);
    }

    if (outcome.type === "response") {
      const response = outcome.response;
      if (response.status >= 500) {
        lastError = `HTTP ${response.status}`;
        sawNonReadyResponse = true;
      } else if (typeof readyText === "string") {
        const body = outcome.body ?? "";
        if (body.includes(readyText)) return;
        lastError = `Response body did not include readiness text "${readyText}"`;
        sawNonReadyResponse = true;
      } else {
        return;
      }
    } else {
      if (!sawNonReadyResponse) {
        lastError = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      }
    }

    const delayMs = Math.min(500, deadline - Date.now());
    if (delayMs > 0) {
      const delay = new Promise<{ type: "delay" }>((resolve) => {
        setTimeout(() => resolve({ type: "delay" }), delayMs);
      });
      const delayOutcome = processExit ? await Promise.race([delay, processExit]) : await delay;
      if (delayOutcome.type === "exit") {
        throw earlyExitError(url, delayOutcome.result);
      }
    }
  }

  throw new Error(`Timed out waiting for ${url}. Last error: ${lastError}`);
}
