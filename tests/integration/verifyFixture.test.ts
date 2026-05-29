import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/loadConfig.js";
import { shipGateConfigSchema } from "../../src/config/schema.js";
import { runVerification } from "../../src/core/runner.js";

const fixturesRoot = fileURLToPath(new URL("../fixtures", import.meta.url));

async function copyFixture(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `shipgate-integration-${name}-`));
  await cp(path.join(fixturesRoot, name), root, { recursive: true });
  return root;
}

async function reservePort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });

  return port;
}

describe("fixture verification", () => {
  it("passes a CLI build and flows from a fresh copy", async () => {
    const root = await copyFixture("node-cli-pass");

    try {
      const loaded = await loadConfig(root);
      const result = await runVerification(root, loaded.config, { fresh: true });

      expect(result.status).toBe("passed");
      expect(result.fresh).toBe(true);
      expect(result.steps.map((step) => step.id)).toEqual([
        "preflight:required-files",
        "test",
        "build",
        "cli:built CLI help works",
        "file:built CLI exists"
      ]);
      expect(existsSync(path.join(root, ".shipgate", "latest-report.md"))).toBe(true);
      expect(existsSync(path.join(root, ".shipgate", "latest-repair-prompt.md"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs only the selected verification step when --step is used", async () => {
    const root = await copyFixture("node-cli-pass");

    try {
      const loaded = await loadConfig(root);
      const result = await runVerification(root, loaded.config, { fresh: true, step: "build" });

      expect(result.status).toBe("passed");
      expect(result.steps.map((step) => step.id)).toEqual([
        "preflight:required-files",
        "build"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when --step does not match a configured step", async () => {
    const root = await copyFixture("node-cli-pass");

    try {
      const loaded = await loadConfig(root);
      const result = await runVerification(root, loaded.config, { fresh: true, step: "does-not-exist" });

      expect(result.status).toBe("failed");
      expect(result.steps.map((step) => step.id)).toEqual([
        "preflight:required-files",
        "preflight:selected-step"
      ]);
      expect(result.steps.at(-1)?.error).toContain('No configured verification step matched "does-not-exist"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails a required configured test and writes a repair prompt", async () => {
    const root = await copyFixture("command-fail");

    try {
      const loaded = await loadConfig(root);
      const result = await runVerification(root, loaded.config, { fresh: true });
      const report = await readFile(path.join(root, ".shipgate", "latest-report.md"), "utf8");
      const prompt = await readFile(path.join(root, ".shipgate", "latest-repair-prompt.md"), "utf8");

      expect(result.status).toBe("failed");
      expect(result.steps.map((step) => step.id)).toEqual(["preflight:required-files", "test"]);
      expect(report).toContain("intentional fixture test failure");
      expect(prompt).toContain("node scripts/fail-test.mjs");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs configured command hooks around verification phases", async () => {
    const root = await copyFixture("hooks-pass");

    try {
      const loaded = await loadConfig(root);
      const result = await runVerification(root, loaded.config, { fresh: true });

      expect(result.status).toBe("passed");
      expect(result.steps.map((step) => step.id)).toEqual([
        "preflight:required-files",
        "hook:beforeVerify:prepare verify marker",
        "test",
        "hook:beforeFlows:prepare flow marker",
        "file:flow marker exists",
        "hook:afterFlows:after flows hook",
        "hook:afterVerify:after verify hook"
      ]);
      expect(result.steps.find((step) => step.id === "hook:afterVerify:after verify hook")?.stdoutExcerpt)
        .toContain("wrote after-verify-marker.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails a required command hook and writes a repair prompt", async () => {
    const root = await copyFixture("hook-fail");

    try {
      const loaded = await loadConfig(root);
      const result = await runVerification(root, loaded.config, { fresh: true });
      const prompt = await readFile(path.join(root, ".shipgate", "latest-repair-prompt.md"), "utf8");

      expect(result.status).toBe("failed");
      expect(result.steps.map((step) => step.id)).toEqual([
        "preflight:required-files",
        "hook:beforeVerify:failing setup"
      ]);
      expect(prompt).toContain("intentional beforeVerify hook failure");
      expect(prompt).toContain("node scripts/fail-hook.mjs");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("verifies a package from a copied monorepo workspace root", async () => {
    const root = await copyFixture("monorepo-workspace");
    const appRoot = path.join(root, "packages", "app");

    try {
      const loaded = await loadConfig(appRoot);
      const result = await runVerification(appRoot, loaded.config, {
        fresh: true,
        configDir: loaded.dir
      });
      const report = await readFile(path.join(appRoot, ".shipgate", "latest-report.md"), "utf8");

      expect(result.status).toBe("passed");
      expect(result.packageManager).toBe("pnpm");
      expect(result.projectRoot).toBe(appRoot);
      expect(result.workspaceRoot).toBe(root);
      expect(result.verificationWorkspaceRoot).not.toBe(root);
      expect(result.verificationRoot).toBe(path.join(result.verificationWorkspaceRoot ?? "", "packages", "app"));
      expect(result.steps.map((step) => step.id)).toEqual([
        "preflight:required-files",
        "test",
        "hook:beforeFlows:write generated marker",
        "file:generated marker exists"
      ]);
      expect(result.steps.find((step) => step.id === "test")?.stdoutExcerpt)
        .toContain("workspace root available from package verification");
      expect(report).toContain("Workspace root:");
      expect(report).toContain("Verification workspace root:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a server process that exits before app readiness", async () => {
    const root = await copyFixture("server-exit");

    try {
      const loaded = await loadConfig(root);
      const result = await runVerification(root, loaded.config, { fresh: true });
      const report = await readFile(path.join(root, ".shipgate", "latest-report.md"), "utf8");

      expect(result.status).toBe("failed");
      expect(result.steps.at(-1)?.id).toBe("fatal");
      expect(report).toContain("Application process exited before http://127.0.0.1:1 became ready");
      expect(report).toContain("intentional startup failure");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts a managed API app and verifies a relative API flow from a fresh copy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shipgate-integration-api-pass-"));
    const port = await reservePort();
    const appUrl = `http://127.0.0.1:${port}`;

    try {
      await cp(path.join(fixturesRoot, "node-cli-pass", "README.md"), path.join(root, "README.md"));
      await cp(path.join(fixturesRoot, "node-cli-pass", "package.json"), path.join(root, "package.json"));
      await writeFile(path.join(root, "server.mjs"), [
        'import { createServer } from "node:http";',
        "const port = Number(process.env.PORT);",
        "if (!port) {",
        '  console.error("PORT is required");',
        "  process.exit(1);",
        "}",
        "const server = createServer((request, response) => {",
        '  response.setHeader("content-type", "text/plain");',
        '  if (request.url === "/health") {',
        '    response.end("api ok");',
        "  } else {",
        '    response.end("ready");',
        "  }",
        "});",
        'server.listen(port, "127.0.0.1", () => {',
        '  console.log(`api fixture listening on ${port}`);',
        "});"
      ].join("\n"), "utf8");

      const config = shipGateConfigSchema.parse({
        profile: "generic",
        packageManager: "npm",
        commands: {
          start: {
            name: "start api fixture",
            command: "node server.mjs",
            env: {
              PORT: String(port)
            }
          }
        },
        app: {
          kind: "api",
          url: appUrl,
          readyText: "ready",
          readyTimeoutMs: 5000
        },
        flows: [
          {
            name: "health endpoint works",
            kind: "api",
            url: "/health",
            expect: {
              status: 200,
              bodyIncludes: ["api ok"]
            }
          }
        ],
        requiredFiles: ["README.md", "package.json", "server.mjs"]
      });

      const result = await runVerification(root, config, { fresh: true });
      const apiStep = result.steps.find((step) => step.id === "api:health endpoint works");

      expect(result.status).toBe("passed");
      expect(result.steps.map((step) => step.id)).toEqual([
        "preflight:required-files",
        "api:health endpoint works"
      ]);
      expect(apiStep?.details).toMatchObject({
        url: `${appUrl}/health`,
        status: 200
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
