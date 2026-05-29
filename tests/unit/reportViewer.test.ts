import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VerificationResult } from "../../src/config/schema.js";
import {
  loadReportViewerData,
  renderReportViewer,
  startReportViewer
} from "../../src/core/reportViewer.js";

const tempRoots: string[] = [];
const time = "2026-05-29T00:00:00.000Z";

async function createReportProject(): Promise<{
  root: string;
  result: VerificationResult;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "shipgate-report-viewer-test-"));
  tempRoots.push(root);
  const shipgateDir = path.join(root, ".shipgate");
  await mkdir(shipgateDir, { recursive: true });

  const result: VerificationResult = {
    status: "failed",
    fresh: true,
    profile: "node-cli",
    packageManager: "pnpm",
    projectRoot: root,
    verificationRoot: root,
    startedAt: time,
    endedAt: time,
    durationMs: 12,
    steps: [
      {
        id: "test",
        name: "test <script>",
        kind: "command",
        status: "failed",
        required: true,
        startedAt: time,
        endedAt: time,
        durationMs: 10,
        command: "pnpm test",
        exitCode: 1,
        error: "Expected value <ok>",
        stderrExcerpt: "Assertion failed",
        artifacts: [
          {
            kind: "log",
            label: "stderr",
            path: path.join(root, ".shipgate", "artifacts", "run", "stderr.log")
          }
        ]
      }
    ],
    artifacts: [],
    reportPath: path.join(root, ".shipgate", "reports", "report.md"),
    repairPromptPath: path.join(root, ".shipgate", "latest-repair-prompt.md")
  };

  await writeFile(path.join(shipgateDir, "latest-report.md"), "# ShipGate Verification Report\n\nStatus: **FAILED**\n", "utf8");
  await writeFile(path.join(shipgateDir, "latest-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");

  return { root, result };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("report viewer", () => {
  it("renders structured result data and escapes HTML", async () => {
    const { root } = await createReportProject();
    const data = await loadReportViewerData(root);
    const html = renderReportViewer(data);

    expect(html).toContain("ShipGate Report: FAILED");
    expect(html).toContain("test &lt;script&gt;");
    expect(html).toContain("Expected value &lt;ok&gt;");
    expect(html).toContain(".shipgate/artifacts/run/stderr.log");
    expect(html).toContain("Raw markdown report");
  });

  it("serves the viewer and raw latest artifacts over HTTP", async () => {
    const { root, result } = await createReportProject();
    const viewer = await startReportViewer({ projectRoot: root });

    try {
      const html = await fetch(viewer.url).then((response) => response.text());
      const markdown = await fetch(`${viewer.url}/latest-report.md`).then((response) => response.text());
      const json = await fetch(`${viewer.url}/latest-result.json`).then((response) => response.json()) as VerificationResult;

      expect(html).toContain("ShipGate Report: FAILED");
      expect(markdown).toContain("Status: **FAILED**");
      expect(json.status).toBe(result.status);
      expect(json.steps[0]?.name).toBe("test <script>");
    } finally {
      await viewer.close();
    }
  });
});
