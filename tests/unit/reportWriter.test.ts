import { mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeReport } from "../../src/core/reportWriter.js";
import type { VerificationResult } from "../../src/config/schema.js";

describe("report writer", () => {
  it("writes a report", async () => {
    const root = path.join(tmpdir(), `shipgate-report-test-${Date.now()}-${Math.random()}`);
    mkdirSync(path.join(root, ".shipgate", "reports"), { recursive: true });

    const reportPath = path.join(root, ".shipgate", "reports", "report.md");
    const result: VerificationResult = {
      status: "passed",
      fresh: false,
      profile: "generic",
      packageManager: "pnpm",
      projectRoot: root,
      verificationRoot: root,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1,
      steps: [],
      artifacts: [],
      reportPath
    };

    await writeReport(result);
    expect(existsSync(reportPath)).toBe(true);
    expect(existsSync(path.join(root, ".shipgate", "latest-report.md"))).toBe(true);
  });
});
