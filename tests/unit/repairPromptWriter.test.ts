import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { VerificationResult } from "../../src/config/schema.js";
import { writeRepairPrompt } from "../../src/core/repairPromptWriter.js";

function result(projectRoot: string, status: VerificationResult["status"]): VerificationResult {
  const time = new Date().toISOString();
  return {
    status,
    fresh: true,
    profile: "generic",
    packageManager: "pnpm",
    projectRoot,
    verificationRoot: projectRoot,
    startedAt: time,
    endedAt: time,
    durationMs: 1,
    steps: status === "failed"
      ? [{
          id: "test",
          name: "test",
          kind: "command",
          status: "failed",
          required: true,
          startedAt: time,
          endedAt: time,
          durationMs: 1,
          command: "pnpm test",
          exitCode: 1
        }]
      : [],
    artifacts: [],
    reportPath: path.join(projectRoot, ".shipgate", "reports", "report.md")
  };
}

describe("writeRepairPrompt", () => {
  it("removes a stale prompt after a passing verification", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shipgate-repair-test-"));
    const promptPath = path.join(root, ".shipgate", "latest-repair-prompt.md");

    await writeRepairPrompt(result(root, "failed"));
    expect(existsSync(promptPath)).toBe(true);

    await writeRepairPrompt(result(root, "passed"));
    expect(existsSync(promptPath)).toBe(false);

    await rm(root, { recursive: true, force: true });
  });
});
