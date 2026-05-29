import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import type {
  CommandHookPhase,
  CommandStepConfig,
  ShipGateConfig,
  StepResult,
  VerificationResult
} from "../config/schema.js";
import { normalizeStartCommand, normalizeVerificationCommands } from "../config/normalizeCommands.js";
import { detectPackageManager } from "../config/detectProject.js";
import { createArtifactStore } from "./artifactStore.js";
import { runCommandStep } from "./commandRunner.js";
import { createFreshCopy } from "./freshCopy.js";
import { startManagedProcess, waitForUrl, type ManagedProcess } from "./processManager.js";
import { runBrowserFlow } from "../browser/playwrightRunner.js";
import { runCliFlow } from "../checks/cliCheck.js";
import { runApiFlow } from "../checks/apiCheck.js";
import { runFileFlow } from "../checks/fileCheck.js";
import { writeReport } from "./reportWriter.js";
import { writeRepairPrompt } from "./repairPromptWriter.js";
import { durationMs, nowIso, safeTimestamp } from "../utils/time.js";

export type VerifyOptions = {
  fresh?: boolean;
  keepTemp?: boolean;
  noBrowser?: boolean;
  step?: string;
  configDir?: string;
};

function makeStep(
  id: string,
  name: string,
  kind: StepResult["kind"],
  status: StepResult["status"],
  startedAt: string,
  start: number,
  error?: string,
  details?: Record<string, unknown>
): StepResult {
  return {
    id,
    name,
    kind,
    status,
    required: true,
    startedAt,
    endedAt: nowIso(),
    durationMs: durationMs(start),
    error,
    details
  };
}

async function runRequiredFiles(config: ShipGateConfig, cwd: string): Promise<StepResult> {
  const startedAt = nowIso();
  const start = Date.now();
  const missing = config.requiredFiles.filter((file) => !existsSync(path.join(cwd, file)));

  return makeStep(
    "preflight:required-files",
    "Required files",
    "preflight",
    missing.length ? "failed" : "passed",
    startedAt,
    start,
    missing.length ? `Missing required files: ${missing.join(", ")}` : undefined,
    { missing, requiredFiles: config.requiredFiles }
  );
}

function hasBlockingFailure(steps: StepResult[]): boolean {
  return steps.some((step) => step.status === "failed" && step.required);
}

function selectedStepMatches(selected: string | undefined, id: string, step: CommandStepConfig): boolean {
  return !selected || selected === id || selected === step.name;
}

function flowStepId(flow: ShipGateConfig["flows"][number]): string {
  return `${flow.kind}:${flow.name}`;
}

function selectedFlowMatches(selected: string | undefined, flow: ShipGateConfig["flows"][number]): boolean {
  return !selected || selected === flowStepId(flow) || selected === flow.name;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveWorkspaceRoots(
  outputRoot: string,
  config: ShipGateConfig,
  configDir = outputRoot
): {
  sourceWorkspaceRoot: string;
  sourceProjectRoot: string;
  projectRelativePath: string;
} {
  const sourceWorkspaceRoot = path.resolve(configDir, config.workspace.root);
  const projectRelativePath = config.workspace.projectDir ??
    (path.relative(sourceWorkspaceRoot, configDir) || ".");
  const sourceProjectRoot = path.resolve(sourceWorkspaceRoot, projectRelativePath);

  if (!isInside(sourceWorkspaceRoot, sourceProjectRoot)) {
    throw new Error(
      `Workspace projectDir must resolve inside workspace root. root=${sourceWorkspaceRoot} projectDir=${projectRelativePath}`
    );
  }

  return {
    sourceWorkspaceRoot,
    sourceProjectRoot,
    projectRelativePath
  };
}

export async function runVerification(
  projectRoot: string,
  config: ShipGateConfig,
  options: VerifyOptions = {}
): Promise<VerificationResult> {
  const startedAt = nowIso();
  const start = Date.now();
  const runId = safeTimestamp();
  const roots = resolveWorkspaceRoots(projectRoot, config, options.configDir);
  const store = await createArtifactStore(projectRoot, runId);
  const steps: StepResult[] = [];
  const artifacts = [];
  const packageManager = config.packageManager === "auto"
    ? detectPackageManager(roots.sourceWorkspaceRoot)
    : config.packageManager;

  let verificationWorkspaceRoot = roots.sourceWorkspaceRoot;
  let verificationRoot = roots.sourceProjectRoot;
  let freshCopy: Awaited<ReturnType<typeof createFreshCopy>> | undefined;
  let server: ManagedProcess | undefined;
  let shouldRunAfterVerifyHooks = false;
  let matchedSelectedStep = !options.step;

  async function runCommandSequence(
    commandSteps: CommandStepConfig[],
    idForStep: (step: CommandStepConfig) => string
  ): Promise<boolean> {
    for (const commandStep of commandSteps) {
      const id = idForStep(commandStep);
      if (!selectedStepMatches(options.step, id, commandStep)) continue;
      matchedSelectedStep = true;

      const result = await runCommandStep(id, commandStep, verificationRoot, store, config.env);
      steps.push(result);

      if (result.status === "failed" && result.required && config.failurePolicy.stopOnFirstCommandFailure) {
        return true;
      }
    }

    return false;
  }

  async function runHookPhase(phase: CommandHookPhase): Promise<boolean> {
    return runCommandSequence(
      config.hooks[phase],
      (commandStep) => `hook:${phase}:${commandStep.name}`
    );
  }

  try {
    if (options.fresh) {
      freshCopy = await createFreshCopy(roots.sourceWorkspaceRoot, config.fresh.exclude);
      verificationWorkspaceRoot = freshCopy.tempRoot;
      verificationRoot = path.join(freshCopy.tempRoot, roots.projectRelativePath);
      artifacts.push({
        kind: "temp" as const,
        label: "fresh verification workspace root",
        path: verificationWorkspaceRoot
      });
    }

    const requiredFiles = await runRequiredFiles(config, verificationRoot);
    steps.push(requiredFiles);
    let stopped = requiredFiles.status === "failed" && config.failurePolicy.stopOnFirstCommandFailure;

    if (!stopped) {
      shouldRunAfterVerifyHooks = true;
      stopped = await runHookPhase("beforeVerify");
    }

    if (!stopped) {
      stopped = await runCommandSequence(
        normalizeVerificationCommands(config.commands),
        (commandStep) => commandStep.name
      );
    }

    const flows = (options.noBrowser ? config.flows.filter((flow) => flow.kind !== "browser") : config.flows)
      .filter((flow) => selectedFlowMatches(options.step, flow));
    const needsApp = flows.some((flow) => flow.kind === "browser" || flow.kind === "api");
    let flowPhaseStarted = false;

    if (!stopped && !hasBlockingFailure(steps)) {
      stopped = await runHookPhase("beforeFlows");
    }

    if (!stopped && !hasBlockingFailure(steps)) {
      flowPhaseStarted = true;
    }

    if (flowPhaseStarted && needsApp && config.app) {
      const startCommand = normalizeStartCommand(config.commands);
      if (startCommand) {
        server = await startManagedProcess(startCommand, verificationRoot, store, config.env);
        artifacts.push(...server.artifacts);
        await waitForUrl(config.app.url, config.app.readyTimeoutMs, config.app.readyText, server.process);
      }
    }

    if (flowPhaseStarted) {
      for (const flow of flows) {
        matchedSelectedStep = true;
        if (flow.kind === "browser") {
          steps.push(await runBrowserFlow(flow, config, verificationRoot, store));
        } else if (flow.kind === "cli") {
          steps.push(await runCliFlow(flow, verificationRoot, store, config.env));
        } else if (flow.kind === "api") {
          steps.push(await runApiFlow(flow, config.app?.url));
        } else if (flow.kind === "file") {
          steps.push(await runFileFlow(flow, verificationRoot));
        }

        const last = steps[steps.length - 1];
        if (last?.status === "failed" && config.failurePolicy.stopOnFirstCommandFailure) {
          break;
        }
      }
    }

    if (flowPhaseStarted) {
      await runHookPhase("afterFlows");
    }

    if (options.step && !matchedSelectedStep && !hasBlockingFailure(steps)) {
      const selectedStepStartedAt = nowIso();
      const selectedStepStart = Date.now();
      steps.push(makeStep(
        "preflight:selected-step",
        "Selected step",
        "preflight",
        "failed",
        selectedStepStartedAt,
        selectedStepStart,
        `No configured verification step matched "${options.step}".`,
        { selected: options.step }
      ));
    }
  } catch (error) {
    const started = nowIso();
    const now = Date.now();
    steps.push(makeStep(
      "fatal",
      "Fatal verification error",
      "preflight",
      "failed",
      started,
      now,
      error instanceof Error ? error.message : String(error)
    ));
  } finally {
    if (server) await server.stop();

    if (shouldRunAfterVerifyHooks) {
      await runHookPhase("afterVerify");
    }

    if (freshCopy && !(options.keepTemp ?? config.fresh.keepTemp)) {
      await freshCopy.cleanup();
    }
  }

  const status = hasBlockingFailure(steps) ? "failed" : "passed";
  const result: VerificationResult = {
    status,
    fresh: Boolean(options.fresh),
    profile: config.profile,
    packageManager,
    projectRoot,
    verificationRoot,
    workspaceRoot: roots.sourceWorkspaceRoot,
    verificationWorkspaceRoot,
    startedAt,
    endedAt: nowIso(),
    durationMs: durationMs(start),
    steps,
    artifacts,
    reportPath: path.join(store.reportsDir, `${runId}-report.md`)
  };

  await mkdir(path.join(projectRoot, ".shipgate"), { recursive: true });
  await writeReport(result);
  const repairPath = await writeRepairPrompt(result);
  if (repairPath) result.repairPromptPath = repairPath;

  const resultPath = path.join(projectRoot, ".shipgate", "latest-result.json");
  await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
  artifacts.push({ kind: "json", label: "latest result json", path: resultPath });

  return result;
}
