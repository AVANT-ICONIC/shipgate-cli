import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { shipGateJsonSchema } from "../config/jsonSchema.js";
import { loadConfig } from "../config/loadConfig.js";
import type { StepResult, VerificationResult } from "../config/schema.js";
import { runVerification } from "../core/runner.js";

export type VerifyToolInput = {
  projectRoot?: string;
  config?: string;
  fresh?: boolean;
  keepTemp?: boolean;
  noBrowser?: boolean;
  step?: string;
};

export type LatestArtifactInput = {
  projectRoot?: string;
  json?: boolean;
};

function resolveProjectRoot(projectRoot?: string): string {
  return path.resolve(projectRoot ?? process.cwd());
}

function textResult(text: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text
      }
    ]
  };
}

function jsonResult(value: unknown): CallToolResult {
  return textResult(`${JSON.stringify(value, null, 2)}\n`);
}

function failedSteps(result: VerificationResult): Array<Pick<StepResult, "id" | "name" | "kind" | "status" | "error">> {
  return result.steps
    .filter((step) => step.status === "failed")
    .map((step) => ({
      id: step.id,
      name: step.name,
      kind: step.kind,
      status: step.status,
      error: step.error
    }));
}

export function summarizeVerification(result: VerificationResult): Record<string, unknown> {
  return {
    status: result.status,
    fresh: result.fresh,
    profile: result.profile,
    packageManager: result.packageManager,
    projectRoot: result.projectRoot,
    verificationRoot: result.verificationRoot,
    workspaceRoot: result.workspaceRoot,
    verificationWorkspaceRoot: result.verificationWorkspaceRoot,
    reportPath: result.reportPath,
    repairPromptPath: result.repairPromptPath,
    failedSteps: failedSteps(result),
    stepCount: result.steps.length,
    durationMs: result.durationMs
  };
}

export async function handleVerifyTool(input: VerifyToolInput = {}): Promise<CallToolResult> {
  const projectRoot = resolveProjectRoot(input.projectRoot);
  const loaded = await loadConfig(projectRoot, input.config);
  const result = await runVerification(projectRoot, loaded.config, {
    fresh: input.fresh ?? true,
    keepTemp: input.keepTemp ?? false,
    noBrowser: input.noBrowser ?? false,
    step: input.step,
    configDir: path.dirname(loaded.path)
  });

  return jsonResult(summarizeVerification(result));
}

export async function handleLatestReportTool(input: LatestArtifactInput = {}): Promise<CallToolResult> {
  const projectRoot = resolveProjectRoot(input.projectRoot);
  const file = path.join(projectRoot, ".shipgate", input.json ? "latest-result.json" : "latest-report.md");

  if (!existsSync(file)) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `No ShipGate ${input.json ? "result JSON" : "report"} found at ${file}. Run shipgate verify first.`
        }
      ]
    };
  }

  return textResult(await readFile(file, "utf8"));
}

export async function handleRepairPromptTool(input: { projectRoot?: string } = {}): Promise<CallToolResult> {
  const projectRoot = resolveProjectRoot(input.projectRoot);
  const file = path.join(projectRoot, ".shipgate", "latest-repair-prompt.md");

  if (!existsSync(file)) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `No ShipGate repair prompt found at ${file}. Run a failing shipgate verify first.`
        }
      ]
    };
  }

  return textResult(await readFile(file, "utf8"));
}

export async function handleConfigSchemaTool(): Promise<CallToolResult> {
  return jsonResult(shipGateJsonSchema);
}
