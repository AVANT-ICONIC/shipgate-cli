import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCliFlow } from "../../src/checks/cliCheck.js";
import { createArtifactStore } from "../../src/core/artifactStore.js";

describe("CLI checks", () => {
  it("matches expectations against full command output, not only report excerpts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shipgate-cli-flow-long-output-"));
    const store = await createArtifactStore(root, "run");
    const scriptPath = path.join(root, "long-output.mjs");

    try {
      await writeFile(scriptPath, [
        "process.stdout.write('x'.repeat(3500));",
        "process.stdout.write('needle-after-excerpt');"
      ].join("\n"), "utf8");

      const result = await runCliFlow({
        name: "long output",
        kind: "cli",
        command: "node long-output.mjs",
        expect: {
          exitCode: 0,
          stdoutIncludes: ["needle-after-excerpt"],
          stderrIncludes: []
        }
      }, root, store, {});

      expect(result.status).toBe("passed");
      expect(result.stdoutExcerpt).not.toContain("needle-after-excerpt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let infrastructure failures pass by matching the expected exit code", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shipgate-cli-flow-timeout-"));
    const store = await createArtifactStore(root, "run");
    const scriptPath = path.join(root, "hang.mjs");

    try {
      await writeFile(scriptPath, "setTimeout(() => {}, 1000);\n", "utf8");

      const result = await runCliFlow({
        name: "timeout",
        kind: "cli",
        command: "node hang.mjs",
        timeoutMs: 20,
        expect: {
          exitCode: 1,
          stdoutIncludes: [],
          stderrIncludes: []
        }
      }, root, store, {});

      expect(result.status).toBe("failed");
      expect(result.error).toContain("timed out");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
