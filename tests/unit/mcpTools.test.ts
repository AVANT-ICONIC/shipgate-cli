import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  handleConfigSchemaTool,
  handleLatestReportTool,
  handleRepairPromptTool,
  handleVerifyTool
} from "../../src/mcp/tools.js";

const tempRoots: string[] = [];

function textContent(result: CallToolResult): string {
  const first = result.content[0];
  if (first?.type !== "text") {
    throw new Error("Expected text MCP content.");
  }

  return first.text;
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "shipgate-mcp-test-"));
  tempRoots.push(root);

  await writeFile(path.join(root, "README.md"), "# MCP test\n", "utf8");
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "shipgate-mcp-test", version: "0.0.0" }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(root, "shipgate.config.json"),
    `${JSON.stringify(
      {
        profile: "node-cli",
        packageManager: "npm",
        commands: {},
        flows: [],
        requiredFiles: ["README.md", "package.json"]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MCP tool handlers", () => {
  it("runs verification and returns a compact JSON summary", async () => {
    const root = await createProject();

    const result = await handleVerifyTool({ projectRoot: root, fresh: false });
    const summary = JSON.parse(textContent(result)) as {
      status: string;
      fresh: boolean;
      projectRoot: string;
      reportPath: string;
      repairPromptPath?: string;
      failedSteps: unknown[];
    };

    expect(summary.status).toBe("passed");
    expect(summary.fresh).toBe(false);
    expect(summary.projectRoot).toBe(root);
    expect(summary.failedSteps).toEqual([]);
    expect(existsSync(summary.reportPath)).toBe(true);
    expect(summary.repairPromptPath).toBeUndefined();
    expect(existsSync(path.join(root, ".shipgate", "latest-result.json"))).toBe(true);
  });

  it("reads the latest markdown report", async () => {
    const root = await createProject();
    const shipgateDir = path.join(root, ".shipgate");
    await mkdir(shipgateDir, { recursive: true });
    await writeFile(path.join(shipgateDir, "latest-report.md"), "# Report\n\nStatus: passed\n", "utf8");

    const result = await handleLatestReportTool({ projectRoot: root });

    expect(textContent(result)).toContain("Status: passed");
  });

  it("reads the latest JSON result when requested", async () => {
    const root = await createProject();
    const shipgateDir = path.join(root, ".shipgate");
    await mkdir(shipgateDir, { recursive: true });
    await writeFile(path.join(shipgateDir, "latest-result.json"), "{\"status\":\"passed\"}\n", "utf8");

    const result = await handleLatestReportTool({ projectRoot: root, json: true });

    expect(JSON.parse(textContent(result))).toEqual({ status: "passed" });
  });

  it("returns a tool error when no repair prompt exists", async () => {
    const root = await createProject();

    const result = await handleRepairPromptTool({ projectRoot: root });

    expect(result.isError).toBe(true);
    expect(textContent(result)).toContain("No ShipGate repair prompt found");
  });

  it("returns the config JSON Schema", async () => {
    const result = await handleConfigSchemaTool();
    const schema = JSON.parse(textContent(result)) as { title: string };

    expect(schema.title).toBe("ShipGate Configuration");
  });
});
