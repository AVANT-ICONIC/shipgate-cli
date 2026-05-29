import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createArtifactStore } from "../../src/core/artifactStore.js";
import { startManagedProcess, stopProcessTree, waitForUrl } from "../../src/core/processManager.js";

const servers: Array<ReturnType<typeof createServer>> = [];

async function serve(body: string): Promise<string> {
  const server = createServer((_request, response) => {
    response.end(body);
  });
  servers.push(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function serveHangingBody(): Promise<ReturnType<typeof createServer>> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("partial");
  });
  servers.push(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return server;
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 1000;

  while (!existsSync(filePath) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  if (!existsSync(filePath)) {
    throw new Error(`Timed out waiting for ${filePath}`);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

afterEach(async () => {
  const openServers = servers.splice(0);
  for (const server of openServers) {
    server.closeAllConnections();
  }
  await Promise.all(openServers.map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("stopProcessTree", () => {
  it("uses taskkill for a Windows child process tree", async () => {
    const taskkillPids: number[] = [];
    const child = Object.assign(Promise.resolve(), {
      pid: 711,
      killed: false,
      kill: () => true
    });

    await stopProcessTree(child, {
      platform: "win32",
      runTaskkill: async (pid) => {
        taskkillPids.push(pid);
      }
    });

    expect(taskkillPids).toEqual([711]);
  });

  it("finishes when a terminated POSIX group becomes inaccessible to polling", async () => {
    const signals: Array<NodeJS.Signals | 0> = [];
    const child = Object.assign(Promise.resolve(), {
      pid: 812,
      killed: false,
      kill: () => true
    });

    await stopProcessTree(child, {
      platform: "darwin",
      signalProcess: (_pid, signal) => {
        signals.push(signal);
        if (signal === 0) {
          throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
        }
      }
    });

    expect(signals).toEqual(["SIGTERM", 0]);
  });

  it.skipIf(process.platform === "win32")("terminates a spawned POSIX descendant", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shipgate-process-tree-"));
    const pidPath = path.join(root, "descendant.pid");
    let descendantPid: number | undefined;

    try {
      await writeFile(path.join(root, "spawn-descendant.mjs"), [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
        `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
        "setInterval(() => {}, 1000);"
      ].join("\n"), "utf8");

      const store = await createArtifactStore(root, "process-tree-test");
      const managed = await startManagedProcess({
        name: "start",
        command: "node spawn-descendant.mjs",
        required: true
      }, root, store);

      await waitForFile(pidPath);
      descendantPid = Number(await readFile(pidPath, "utf8"));
      expect(processExists(descendantPid)).toBe(true);

      await managed.stop();

      expect(processExists(descendantPid)).toBe(false);
    } finally {
      if (descendantPid && processExists(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("waitForUrl", () => {
  it("accepts a successful response with configured readiness text", async () => {
    const url = await serve("application ready");

    await expect(waitForUrl(url, 1000, "ready")).resolves.toBeUndefined();
  });

  it("rejects a successful response without configured readiness text", async () => {
    const url = await serve("starting");

    await expect(waitForUrl(url, 1000, "ready"))
      .rejects.toThrow('Response body did not include readiness text "ready"');
  });

  it("times out when readiness text waits on a hanging response body", async () => {
    const server = await serveHangingBody();
    const address = server.address() as AddressInfo;
    const result = await Promise.race([
      waitForUrl(`http://127.0.0.1:${address.port}`, 50, "ready")
        .then(() => "ready" as const)
        .catch((error: unknown) => error),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 1000))
    ]);

    expect(result).not.toBe("hung");
    expect(result).toBeInstanceOf(Error);
  });


  it("reports a managed process that exits before readiness", async () => {
    const process = Promise.resolve({
      exitCode: 1,
      stderr: "startup configuration is invalid"
    });

    await expect(waitForUrl("http://127.0.0.1:1", 1000, undefined, process))
      .rejects.toThrow(
        "Application process exited before http://127.0.0.1:1 became ready (exit code 1). " +
        "Stderr: startup configuration is invalid"
      );
  });
});
