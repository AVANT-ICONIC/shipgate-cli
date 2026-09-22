import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize, compareRuns, runCli } from "../../../scripts/cleanroom-parity.mjs";
import { createFreshCopy } from "../../../src/core/freshCopy.js";
import { initialize } from "@avant-iconic/cleanroom/src/init.mjs";
import { loadConfig } from "@avant-iconic/cleanroom/src/config.mjs";
import { scan } from "@avant-iconic/cleanroom/src/scanner.mjs";
import { makeBaseline } from "@avant-iconic/cleanroom/src/baseline.mjs";

const roots: string[] = [];

async function gitFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "shipgate-parity-"));
  roots.push(root);
  spawnSync("git", ["init", "-q", root]);
  spawnSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  spawnSync("git", ["-C", root, "config", "user.name", "test"]);
  await writeFile(path.join(root, "README.md"), "fixture\n");
  spawnSync("git", ["-C", root, "add", "README.md"]);
  spawnSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  spawnSync("git", ["-C", root, "remote", "add", "origin", "https://example.invalid/fixture.git"]);
  return root;
}

async function fakeCli(root: string, name: string, payload: unknown, exitCode = 0): Promise<string> {
  const file = path.join(root, `${name}.mjs`);
  await writeFile(file, `console.log(${JSON.stringify(JSON.stringify(payload))}); process.exitCode = ${exitCode};\n`);
  await chmod(file, 0o755);
  spawnSync("git", ["-C", root, "add", path.basename(file)]);
  spawnSync("git", ["-C", root, "commit", "-qm", `add ${name}`]);
  return file;
}

function runHarness(args: string[]) {
  return spawnSync(process.execPath, [path.resolve("scripts/cleanroom-parity.mjs"), ...args], {
    cwd: path.resolve("."), encoding: "utf8"
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cleanroom parity harness", () => {
  it("treats only timestamps, durations, temporary roots, and branding as volatile", () => {
    const first = canonicalize({
      timestamp: "one", durationMs: 1, root: "/tmp/a", message: "Green Room at /tmp/a",
      finding: { id: "a", count: 1, hash: "abc" }
    }, ["/tmp/a"]);
    const second = canonicalize({
      timestamp: "two", durationMs: 9, root: "/tmp/b", message: "Cleanroom at /tmp/b",
      finding: { id: "a", count: 1, hash: "abc" }
    }, ["/tmp/b"]);
    expect(first).toEqual(second);
    expect(canonicalize({ path: ".greenroom/registry.json", rule: "greenroom/rule", details: "greenroom" }))
      .toEqual({ path: ".greenroom/registry.json", rule: "greenroom/rule", details: "greenroom" });
  });

  it.each([
    ["finding", { findings: [{ id: "a" }] }, { findings: [{ id: "b" }] }],
    ["count", { count: 1 }, { count: 2 }],
    ["hash", { hash: "abc" }, { hash: "def" }],
    ["exit code", { ok: true }, { ok: true }, 0, 1]
  ])("fails a changed %s", (_label, leftJson, rightJson, leftExit = 0, rightExit = 0) => {
    const comparison = compareRuns(
      { exitCode: leftExit, json: leftJson },
      { exitCode: rightExit, json: rightJson }
    );
    expect(comparison.equal).toBe(false);
  });

  it("writes a zero-diff manifest for equivalent executable output", async () => {
    const repo = await gitFixture();
    const payload = { timestamp: "ignored", findings: [{ id: "same", hash: "abc" }], count: 1 };
    const legacy = await fakeCli(repo, "legacy", payload, 1);
    const shipgate = await fakeCli(repo, "shipgate", { ...payload, timestamp: "different" }, 1);
    const output = path.join(repo, "..", `${path.basename(repo)}-manifest.json`);
    roots.push(output);
    const result = runHarness([
      "--repo", repo, "--legacy-cli", legacy, "--shipgate-cli", shipgate,
      "--ref", "HEAD^", "--output", output
    ]);
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(output, "utf8"));
    expect(manifest.verdict).toBe("zero-diff");
    expect(manifest.repository.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.repository.remote).toBe("https://example.invalid/fixture.git");
    expect(manifest.repository.branch).toBe("master");
    expect(manifest.runtime.node).toBe(process.version);
    expect(manifest.tools.legacy.repository.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.tools.legacy.repository.dirty).toBe(false);
    expect(manifest.tools.shipgate.repository.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("fails closed on dirty input, executable errors, missing output, and invalid JSON", async () => {
    const repo = await gitFixture();
    const good = await fakeCli(repo, "good", { ok: true });
    const noOutput = await fakeCli(repo, "no-output", { ok: true });
    await writeFile(noOutput, "process.exitCode = 2;\n");
    spawnSync("git", ["-C", repo, "add", path.basename(noOutput)]);
    spawnSync("git", ["-C", repo, "commit", "-qm", "no output"]);
    const output = path.join(repo, "..", `${path.basename(repo)}-failed.json`);
    roots.push(output);

    let result = runHarness(["--repo", repo, "--legacy-cli", good, "--shipgate-cli", noOutput, "--ref", "HEAD^", "--output", output]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("produced no JSON output");

    await writeFile(noOutput, 'console.log("not json");\n');
    spawnSync("git", ["-C", repo, "add", path.basename(noOutput)]);
    spawnSync("git", ["-C", repo, "commit", "-qm", "invalid json"]);
    result = runHarness(["--repo", repo, "--legacy-cli", good, "--shipgate-cli", noOutput, "--ref", "HEAD^", "--output", output]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("produced invalid JSON");

    await writeFile(path.join(repo, "dirty.txt"), "dirty\n");
    result = runHarness(["--repo", repo, "--legacy-cli", good, "--shipgate-cli", good, "--ref", "HEAD^", "--output", output]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing dirty worktree");
  });

  it("runs as main through a symlink and rejects bad arguments", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "shipgate-parity-link-"));
    roots.push(directory);
    const link = path.join(directory, "parity-link.mjs");
    await symlink(path.resolve("scripts/cleanroom-parity.mjs"), link);
    const result = spawnSync(process.execPath, [link, "--bad"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing value for --bad");
  });

  it("preserves legacy Cleanroom auto compare-ref and findings in a ShipGate fresh copy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shipgate-cleanroom-fresh-"));
    const bare = await mkdtemp(path.join(tmpdir(), "shipgate-cleanroom-origin-"));
    roots.push(root, bare);
    const git = (...args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    spawnSync("git", ["init", "--bare", "-q", bare]);
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    initialize(root, { existing: true });
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "export const clean = true;\n");
    makeBaseline(root, loadConfig(root), scan(root, loadConfig(root)));
    git("add", "-A"); git("commit", "-qm", "baseline");
    git("remote", "add", "origin", bare); git("push", "-qu", "origin", "main");
    git("checkout", "-qb", "feature");
    await writeFile(path.join(root, "src", "feature-final.ts"), "export const regression = true;\n");
    git("add", "-A"); git("commit", "-qm", "feature violation");

    const legacyCli = path.resolve("node_modules/@avant-iconic/cleanroom/src/cli.mjs");
    const original = runCli(legacyCli, root, "auto");
    const copy = await createFreshCopy(root);
    try {
      const fresh = runCli(legacyCli, copy.tempRoot, "auto");
      expect(fresh.compareRef).toBe(original.compareRef);
      expect(fresh.json["findings"]).toEqual(original.json["findings"]);
      expect(fresh.json["fresh"]).toEqual(original.json["fresh"]);
    } finally {
      await copy.cleanup();
    }
  });
});
