import { existsSync } from "node:fs";
import type { FileFlow, StepResult } from "../config/schema.js";
import { durationMs, nowIso } from "../utils/time.js";
import { resolveLocalPath } from "../utils/pathSafety.js";

export async function runFileFlow(flow: FileFlow, cwd: string): Promise<StepResult> {
  const startedAt = nowIso();
  const start = Date.now();
  const expectedExists = flow.expect?.exists ?? true;
  let fullPath = "";
  let exists = false;
  let error: string | undefined;

  try {
    fullPath = resolveLocalPath(cwd, flow.path, `file flow "${flow.name}" path`);
    exists = existsSync(fullPath);
    if (exists !== expectedExists) {
      error = `Expected ${flow.path} exists=${expectedExists}, got ${exists}`;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  return {
    id: `file:${flow.name}`,
    name: flow.name,
    kind: "file",
    status: error ? "failed" : "passed",
    required: true,
    startedAt,
    endedAt: nowIso(),
    durationMs: durationMs(start),
    error,
    details: {
      path: fullPath,
      exists,
      expectedExists
    }
  };
}
