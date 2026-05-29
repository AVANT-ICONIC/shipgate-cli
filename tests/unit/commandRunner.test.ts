import { existsSync } from "node:fs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createArtifactStore } from "../../src/core/artifactStore.js";
import { runCommandStep } from "../../src/core/commandRunner.js";

describe("runCommandStep", () => {
  it("records raw command output once and removes terminal styling from excerpts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shipgate-command-test-"));
    const store = await createArtifactStore(root, "run");

    const result = await runCommandStep(
      "stdout",
      {
        name: "stdout",
        command: "node -e \"process.stdout.write('\\u001b[32mhello\\u001b[39m')\"",
        required: true
      },
      root,
      store
    );

    expect(result.stdoutExcerpt).toBe("hello");
    expect(await readFile(path.join(store.commandLogsDir, "stdout.stdout.log"), "utf8"))
      .toBe("\u001b[32mhello\u001b[39m");

    await rm(root, { recursive: true, force: true });
  });

  it("honors custom artifact directories and disabled command log artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shipgate-command-artifacts-test-"));
    const store = await createArtifactStore(root, "run", {
      dir: "shipgate-output",
      logs: false,
      screenshots: true,
      traces: true
    });

    const result = await runCommandStep(
      "stdout",
      {
        name: "stdout",
        command: "node -e \"console.log('hello')\"",
        required: true
      },
      root,
      store
    );

    expect(result.status).toBe("passed");
    expect(result.artifacts).toEqual([]);
    expect(result.rawStdout).toContain("hello");
    expect(store.artifactsDir).toBe(path.join(root, "shipgate-output", "run"));
    expect(existsSync(store.commandLogsDir)).toBe(false);

    await rm(root, { recursive: true, force: true });
  });
});
