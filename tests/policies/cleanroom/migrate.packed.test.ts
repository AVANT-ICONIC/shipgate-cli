import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupRoots, makeRoot, runLegacy } from "./step5ParityHarness.js";

/**
 * Spec issue #1 step 6, packed-production acceptance: the packed tarball
 * installed WITHOUT devDependencies must run `migrate cleanroom` against a
 * real legacy fixture. The legacy CLI is a devDependency of this repo, so the
 * packed CLI must accept it via --legacy-cli (and must fail cleanly, before
 * any write, when no legacy CLI is available).
 */

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const legacyCli = path.join(repoRoot, "node_modules", "@avant-iconic", "cleanroom", "src", "cli.mjs");

let installDir: string | null = null;
let packedCli: string | null = null;

function ensurePackedInstall(): string {
  if (packedCli) return packedCli;
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
  const packOut = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", os.tmpdir()], { cwd: repoRoot, encoding: "utf8" });
  const tarball = path.join(os.tmpdir(), packOut.trim().split("\n").pop()!);
  installDir = mkdtempSync(path.join(os.tmpdir(), "shipgate-packed-install-"));
  execFileSync("npm", ["init", "-y"], { cwd: installDir, stdio: "pipe" });
  execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", tarball], { cwd: installDir, stdio: "pipe", timeout: 240_000 });
  rmSync(tarball, { force: true });
  packedCli = path.join(installDir, "node_modules", "@shipgate", "cli", "dist", "cli.js");
  if (!existsSync(packedCli)) throw new Error(`packed CLI not found at ${packedCli}`);
  return packedCli;
}

afterAll(() => {
  cleanupRoots();
  if (installDir) rmSync(installDir, { recursive: true, force: true });
});

describe("cleanroom migration from a packed production install (no devDependencies)", () => {
  it("migrates a real legacy fixture with an explicit --legacy-cli", async () => {
    const cli = ensurePackedInstall();
    expect(existsSync(path.join(installDir!, "node_modules", "@avant-iconic", "cleanroom"))).toBe(false); // truly production
    const root = await makeRoot("violation");
    expect(runLegacy(["init", "--existing"], root).exitCode).toBe(0);
    expect(runLegacy(["baseline"], root).exitCode).toBe(0);

    const run = spawnSync(process.execPath, [cli, "migrate", "cleanroom", "--root", root, "--legacy-cli", legacyCli], { encoding: "utf8", timeout: 120_000 });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Migration complete");
    const marker = JSON.parse(readFileSync(path.join(root, ".shipgate", "policies", "cleanroom", "migration.json"), "utf8"));
    expect(marker.status).toBe("completed");
    expect(typeof marker.parityDigest).toBe("string");
    expect(existsSync(path.join(root, ".greenroom", "baseline.json"))).toBe(true); // legacy kept
  }, 360_000);

  it("without any legacy CLI it fails cleanly before writing anything", async () => {
    const cli = ensurePackedInstall();
    const root = await makeRoot("violation");
    expect(runLegacy(["init", "--existing"], root).exitCode).toBe(0);
    expect(runLegacy(["baseline"], root).exitCode).toBe(0);

    const run = spawnSync(process.execPath, [cli, "migrate", "cleanroom", "--root", root], { encoding: "utf8", timeout: 120_000, env: { ...process.env, PATH: "/usr/bin:/bin" } });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("no legacy Cleanroom CLI found");
    expect(run.stderr).not.toContain("Cannot find module");
    expect(existsSync(path.join(root, ".shipgate"))).toBe(false); // zero writes
  }, 360_000);
});
