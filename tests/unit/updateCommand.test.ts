import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectUpdateScope, makeUpdatePlan } from "../../src/commands/update.js";

describe("update command helpers", () => {
  it("builds GitHub release tarball commands for global and local installs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shipgate-update-test-"));
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.17.0" }));

    expect(makeUpdatePlan({
      projectRoot: root,
      source: "github",
      scope: "global",
      version: "0.1.1"
    })).toMatchObject({
      version: "v0.1.1",
      command: "npm install -g https://github.com/AVANT-ICONIC/shipgate-cli/releases/download/v0.1.1/shipgate-cli-0.1.1.tgz"
    });

    expect(makeUpdatePlan({
      projectRoot: root,
      source: "github",
      scope: "local",
      version: "v0.1.1"
    }).command).toBe(
      "pnpm add -D https://github.com/AVANT-ICONIC/shipgate-cli/releases/download/v0.1.1/shipgate-cli-0.1.1.tgz"
    );

    await rm(root, { recursive: true, force: true });
  });

  it("detects local installs from a project node_modules bin path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shipgate-update-scope-test-"));
    const binDir = path.join(root, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });

    expect(detectUpdateScope(root, path.join(binDir, "shipgate"))).toBe("local");
    expect(detectUpdateScope(root, "/usr/local/bin/shipgate")).toBe("global");

    await rm(root, { recursive: true, force: true });
  });
});
