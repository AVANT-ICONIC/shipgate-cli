import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCleanroomCli } from "../../../src/policies/cleanroom/cli.js";
import { initialize } from "../../../src/policies/cleanroom/init.mjs";
import { loadConfig } from "../../../src/policies/cleanroom/config.mjs";
import { scan } from "../../../src/policies/cleanroom/scanner.mjs";
import { makeBaseline } from "../../../src/policies/cleanroom/baseline.mjs";

// Spec Step 5: the exit-code-collecting dispatcher ports every legacy
// greenroom cli.mjs branch as a returned result. These tests prove the
// process.exit tripwire (dispatcher runs with exit monkey-patched to throw),
// the legacy-site enumeration, and byte parity on data outputs.

const LEGACY_CLI = path.resolve("node_modules/@avant-iconic/cleanroom/src/cli.mjs");
const roots: string[] = [];

type Fixture = { root: string };

async function makeFixture(withViolation: boolean): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "shipgate-cli-dispatch-"));
  roots.push(root);
  const git = (...args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  initialize(root, { existing: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export const clean = true;\n");
  makeBaseline(root, loadConfig(root), scan(root, loadConfig(root)));
  git("add", "-A");
  git("commit", "-qm", "baseline");
  if (withViolation) {
    const dup = Array.from({ length: 30 }, (_, i) => `export const l${i} = "dup-${i}";`).join("\n") + "\n";
    await writeFile(path.join(root, "src", "dup-a.ts"), dup);
    await writeFile(path.join(root, "src", "dup-b.ts"), dup);
    git("add", "-A");
    git("commit", "-qm", "duplicate violation");
  }
  return { root };
}

function runLegacy(args: string[]) {
  const result = spawnSync(process.execPath, [LEGACY_CLI, ...args], { encoding: "utf8" });
  return { exitCode: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Canonicalize only the prose brand, mirroring scripts/cleanroom-parity.mjs. */
function canonical(text: string): string {
  return text
    .replaceAll("shipgate policy cleanroom", "greenroom")
    .replaceAll("ShipGate Cleanroom policy", "Green Room")
    .replaceAll("Green Room failed", "Green Room failed");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cleanroom cli dispatcher (spec Step 5)", () => {
  it("never calls process.exit: the tripwire harness patches it to throw", async () => {
    const { root } = await makeFixture(true);
    const original = process.exit;
    const calls: unknown[] = [];
    process.exit = ((code?: unknown) => { calls.push(code); throw new Error(`process.exit tripwire: ${String(code)}`); }) as never;
    try {
      for (const args of [["version"], ["help"], ["check", "--root", root], ["audit", "--root", root, "--json"], ["explain"], ["waive"], ["unknown-cmd"], ["baseline", "--root", root]]) {
        const result = runCleanroomCli(args, { cwd: root });
        expect([0, 1, 2]).toContain(result.exitCode);
      }
    } finally {
      process.exit = original;
    }
    expect(calls).toEqual([]);
  }, 30_000);

  it("enumerates the 41 legacy process.exit sites it replaces", async () => {
    const source = await readFile(LEGACY_CLI, "utf8");
    const sites = source.split("\n").filter((line) => line.includes("process.exit("));
    // 40 executable sites plus the writeStdout doc comment, pinned so a
    // legacy cli.mjs change fails this test loudly.
    expect(sites.length).toBe(41);
    expect(sites.filter((line) => !line.trim().startsWith("*")).length).toBe(40);
  });

  it.each([
    ["version"],
    ["help"],
    ["check", "--json"],
    ["check"],
    ["audit", "--json"],
    ["providers", "--json"],
    ["next"],
    ["explain"],
    ["waive"],
    ["unwaive"],
    ["responsibility", "list", "--json"],
    ["baseline"],
    ["unknown-cmd"]
  ])("matches the legacy cli on: %s", async (...args: string[]) => {
    const { root } = await makeFixture(true);
    const fullArgs = [...args, "--root", root];
    const legacy = runLegacy(fullArgs);
    const ported = runCleanroomCli(fullArgs, { cwd: root });
    expect(ported.exitCode).toBe(legacy.exitCode);
    expect(canonical(ported.stdout)).toBe(canonical(legacy.stdout));
    expect(canonical(ported.stderr)).toBe(canonical(legacy.stderr));
  }, 60_000);
});
