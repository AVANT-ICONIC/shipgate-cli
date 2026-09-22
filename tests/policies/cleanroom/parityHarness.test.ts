import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize, compareRuns } from "../../../scripts/cleanroom-parity.mjs";

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

    await writeFile(path.join(repo, "dirty.txt"), "dirty\n");
    result = runHarness(["--repo", repo, "--legacy-cli", good, "--shipgate-cli", good, "--ref", "HEAD^", "--output", output]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing dirty worktree");
  });
});
