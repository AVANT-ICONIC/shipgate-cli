import { existsSync } from "node:fs";
import path from "node:path";
import type { FileFlow, StepResult } from "../config/schema.js";
import { durationMs, nowIso } from "../utils/time.js";

export async function runFileFlow(flow: FileFlow, cwd: string): Promise<StepResult> {
  const startedAt = nowIso();
  const start = Date.now();
  const expectedExists = flow.expect?.exists ?? true;
  const fullPath = path.join(cwd, flow.path);
  const exists = existsSync(fullPath);
  const passed = exists === expectedExists;

  return {
    id: `file:${flow.name}`,
    name: flow.name,
    kind: "file",
    status: passed ? "passed" : "failed",
    required: true,
    startedAt,
    endedAt: nowIso(),
    durationMs: durationMs(start),
    error: passed ? undefined : `Expected ${flow.path} exists=${expectedExists}, got ${exists}`,
    details: {
      path: fullPath,
      exists,
      expectedExists
    }
  };
}
