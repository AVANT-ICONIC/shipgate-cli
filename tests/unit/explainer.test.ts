import path from "node:path";
import { describe, expect, it } from "vitest";
import type { StepResult, VerificationResult } from "../../src/config/schema.js";
import {
  createVerificationExplanation,
  formatVerificationExplanation
} from "../../src/core/explainer.js";

const time = "2026-05-29T00:00:00.000Z";

function baseResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  const projectRoot = "/tmp/shipgate-project";

  return {
    status: "passed",
    fresh: true,
    profile: "node-cli",
    packageManager: "pnpm",
    projectRoot,
    verificationRoot: projectRoot,
    startedAt: time,
    endedAt: time,
    durationMs: 10,
    steps: [],
    artifacts: [],
    reportPath: path.join(projectRoot, ".shipgate", "reports", "report.md"),
    ...overrides
  };
}

function failedCommandStep(overrides: Partial<StepResult> = {}): StepResult {
  return {
    id: "test",
    name: "test",
    kind: "command",
    status: "failed",
    required: true,
    startedAt: time,
    endedAt: time,
    durationMs: 5,
    command: "pnpm test",
    exitCode: 1,
    error: "Command failed with exit code 1.",
    stderrExcerpt: "AssertionError: expected true to be false",
    artifacts: [
      {
        kind: "log",
        label: "stderr",
        path: "/tmp/shipgate-project/.shipgate/artifacts/run/command-logs/test-stderr.log"
      }
    ],
    ...overrides
  };
}

describe("ShipGate explanation", () => {
  it("summarizes a passing verification without repair instructions", () => {
    const result = baseResult({
      steps: [
        {
          id: "required-files",
          name: "Required files",
          kind: "preflight",
          status: "passed",
          required: true,
          startedAt: time,
          endedAt: time,
          durationMs: 1
        }
      ]
    });

    const explanation = createVerificationExplanation(result);
    const markdown = formatVerificationExplanation(result);

    expect(explanation.status).toBe("passed");
    expect(explanation.reason).toBe("All required verification steps passed.");
    expect(explanation.failedSteps).toEqual([]);
    expect(explanation.stepCounts).toEqual({ passed: 1, failed: 0, skipped: 0 });
    expect(markdown).toContain("Status: **PASSED**");
    expect(markdown).toContain("No failed steps.");
    expect(markdown).toContain("No repair prompt is expected");
  });

  it("explains the first failing required step and points to artifacts", () => {
    const failedStep = failedCommandStep();
    const result = baseResult({
      status: "failed",
      steps: [
        failedStep,
        {
          id: "build",
          name: "build",
          kind: "command",
          status: "skipped",
          required: true,
          startedAt: time,
          endedAt: time,
          durationMs: 0
        }
      ],
      repairPromptPath: "/tmp/shipgate-project/.shipgate/latest-repair-prompt.md"
    });

    const explanation = createVerificationExplanation(result);
    const markdown = formatVerificationExplanation(result);

    expect(explanation.status).toBe("failed");
    expect(explanation.reason).toContain('Required step "test" failed.');
    expect(explanation.failedSteps).toHaveLength(1);
    expect(explanation.failedSteps[0]?.command).toBe("pnpm test");
    expect(explanation.nextActions).toContain("Inspect or rerun this command: pnpm test");
    expect(markdown).toContain("Status: **FAILED**");
    expect(markdown).toContain("- Command: `pnpm test`");
    expect(markdown).toContain("AssertionError: expected true to be false");
    expect(markdown).toContain(".shipgate/latest-repair-prompt.md");
    expect(markdown).toContain("Rerun `shipgate verify --fresh`");
  });
});
