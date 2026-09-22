import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, symlinkSync, readlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFreshCopy } from "../../src/core/freshCopy.js";

function fixture(): string {
  const dir = path.join(tmpdir(), `shipgate-copy-test-${Date.now()}-${Math.random()}`);
  mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), "{}");
  writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
  writeFileSync(path.join(dir, ".env"), "SECRET=1");
  writeFileSync(path.join(dir, ".env.production"), "SECRET=production");
  writeFileSync(path.join(dir, "node_modules", "x.txt"), "nope");
  mkdirSync(path.join(dir, ".shipgate", "reports"), { recursive: true });
  writeFileSync(path.join(dir, ".shipgate", "latest-result.json"), "{}");
  writeFileSync(path.join(dir, ".shipgate", "reports", "stale-report.md"), "nope");
  mkdirSync(path.join(dir, "packages", "app", "node_modules"), { recursive: true });
  mkdirSync(path.join(dir, "packages", "app", "dist"), { recursive: true });
  mkdirSync(path.join(dir, "packages", "app", ".shipgate", "artifacts"), { recursive: true });
  writeFileSync(path.join(dir, "packages", "app", "package.json"), "{}");
  writeFileSync(path.join(dir, "packages", "app", ".env"), "SECRET=2");
  writeFileSync(path.join(dir, "packages", "app", ".env.test"), "SECRET=test");
  writeFileSync(path.join(dir, "packages", "app", "node_modules", "x.txt"), "nope");
  writeFileSync(path.join(dir, "packages", "app", "dist", "bundle.js"), "nope");
  writeFileSync(path.join(dir, "packages", "app", ".shipgate", "artifacts", "log.txt"), "nope");
  return dir;
}

describe("fresh copy", () => {
  it("preserves lockfile and excludes node_modules and env", async () => {
    const dir = fixture();
    const copy = await createFreshCopy(dir);
    expect(existsSync(path.join(copy.tempRoot, "package.json"))).toBe(true);
    expect(existsSync(path.join(copy.tempRoot, "pnpm-lock.yaml"))).toBe(true);
    expect(existsSync(path.join(copy.tempRoot, "packages", "app", "package.json"))).toBe(true);
    expect(existsSync(path.join(copy.tempRoot, ".env"))).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, ".env.production"))).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, ".shipgate"))).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, "node_modules"))).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, "packages", "app", ".env"))).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, "packages", "app", ".env.test"))).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, "packages", "app", "node_modules"))).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, "packages", "app", "dist"))).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, "packages", "app", ".shipgate", "artifacts"))).toBe(false);
    await copy.cleanup();
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// A FRESH COPY OF A REPOSITORY IS STILL A REPOSITORY.

function gitFixture(): string {
  const dir = path.join(tmpdir(), `shipgate-git-test-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(path.join(dir, ".gitignore"), ".scratch/\nbuilt.js\n");
  writeFileSync(path.join(dir, "package.json"), "{}");
  writeFileSync(path.join(dir, "tracked.js"), "export const tracked = 1;\n");
  mkdirSync(path.join(dir, ".scratch", "vendored"), { recursive: true });
  writeFileSync(path.join(dir, ".scratch", "vendored", "theirs.js"), "export const theirs = 1;\n");
  writeFileSync(path.join(dir, "built.js"), "export const built = 1;\n");
  git("add", ".gitignore", "package.json", "tracked.js");
  git("commit", "-qm", "initial");
  return dir;
}

describe("fresh copy of a git repository", () => {
  it("carries a working .git, so checks that ask git anything get an answer", async () => {
    // 25 of apex-nexus's tests failed here and passed everywhere else, because
    // every one of them interrogates the repository and the copy had no .git.
    const dir = gitFixture();
    const copy = await createFreshCopy(dir);
    expect(copy.hasGit).toBe(true);

    const lsFiles = spawnSync("git", ["-C", copy.tempRoot, "ls-files"], { encoding: "utf8" });
    expect(lsFiles.status).toBe(0);
    expect(lsFiles.stdout).toContain("tracked.js");

    const log = spawnSync("git", ["-C", copy.tempRoot, "log", "--oneline"], { encoding: "utf8" });
    expect(log.status).toBe(0);
    expect(log.stdout).toContain("initial");

    await copy.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("borrows the object store instead of copying it", async () => {
    // apex-nexus's .git is 8.7 GB. Copying that per verify is not a thing
    // anyone runs twice, so the clone is --shared and the objects are borrowed.
    const dir = gitFixture();
    const copy = await createFreshCopy(dir);
    expect(existsSync(path.join(copy.tempRoot, ".git", "objects", "info", "alternates"))).toBe(true);
    await copy.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves out what the project's own .gitignore excludes", async () => {
    // The fresh copy ran 1,144 test files where apex-nexus has 988. The extra
    // 156 came from a vendored checkout under a gitignored path.
    const dir = gitFixture();
    const copy = await createFreshCopy(dir);
    expect(existsSync(path.join(copy.tempRoot, ".scratch"))).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, "built.js"))).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, "tracked.js"))).toBe(true);
    await copy.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("still copies an untracked file that git does not ignore", async () => {
    // Untracked is not ignored. Work in progress is what a verification run
    // exists to judge, and dropping it would make the gate go quiet exactly
    // while a change is being made.
    const dir = gitFixture();
    writeFileSync(path.join(dir, "work-in-progress.js"), "export const wip = 1;\n");
    const copy = await createFreshCopy(dir);
    expect(existsSync(path.join(copy.tempRoot, "work-in-progress.js"))).toBe(true);
    await copy.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("a project that is not a repository copies exactly as it always did", async () => {
    // Soft in every direction: no repository, no git, a clone that refuses for
    // any reason at all. The copy is made without .git, and says so.
    const dir = fixture();
    const copy = await createFreshCopy(dir);
    expect(copy.hasGit).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, "package.json"))).toBe(true);
    expect(existsSync(path.join(copy.tempRoot, "node_modules"))).toBe(false);
    await copy.cleanup();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("fidelity of the copy", () => {
  it("keeps the project's own remotes, not a path to the source directory", async () => {
    // `git clone --local` points origin at the source DIRECTORY. A project that
    // checks where its code would survive from reads that as a local-only
    // remote and is right to fail.
    const dir = gitFixture();
    spawnSync("git", ["-C", dir, "remote", "add", "origin", "https://example.com/project.git"], { encoding: "utf8" });
    const copy = await createFreshCopy(dir);
    const remotes = spawnSync("git", ["-C", copy.tempRoot, "remote", "-v"], { encoding: "utf8" });
    expect(remotes.stdout).toContain("https://example.com/project.git");
    expect(remotes.stdout).not.toContain(dir);
    await copy.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the remote-tracking refs, so a check compares against the same base it would in the project", async () => {
    // `git remote remove origin` takes `refs/remotes/origin/*` with it, and
    // nothing here fetches them back. A check that asks what changed since the
    // default branch then resolves `origin/main` in the project and something
    // else -- the local branch, `HEAD^`, or nothing -- inside the copy, so the
    // same command on the same commit answers differently under --fresh.
    //
    // The dangerous half is quieter: a guard that reads a file as the base
    // branch has it (`git show origin/main:path`) gets nothing back and
    // reports no violation. It fails OPEN. The run is green because the ref
    // was missing, not because the file was unchanged.
    const dir = gitFixture();
    spawnSync("git", ["-C", dir, "remote", "add", "origin", "https://example.com/project.git"], { encoding: "utf8" });
    const copy = await createFreshCopy(dir);

    const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const branch = spawnSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim();
    const tracked = spawnSync("git", ["-C", copy.tempRoot, "rev-parse", `origin/${branch}`], {
      encoding: "utf8",
    });
    expect(tracked.status).toBe(0);
    expect(tracked.stdout.trim()).toBe(head);

    // And the URL is still the project's, which is the reason the remote was
    // touched at all.
    const remotes = spawnSync("git", ["-C", copy.tempRoot, "remote", "-v"], { encoding: "utf8" });
    expect(remotes.stdout).toContain("https://example.com/project.git");
    expect(remotes.stdout).not.toContain(dir);

    await copy.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("copies a relative symlink as the relative symlink it was", async () => {
    // Node's cp resolves relative symlinks to absolute paths unless told not
    // to, so the copy would carry a link to a path on the machine it was made
    // on, which is not what the repository contains.
    const dir = gitFixture();
    mkdirSync(path.join(dir, "a"), { recursive: true });
    mkdirSync(path.join(dir, "b"), { recursive: true });
    writeFileSync(path.join(dir, "b", "real.json"), "{}");
    symlinkSync(path.join("..", "b", "real.json"), path.join(dir, "a", "link.json"));
    const copy = await createFreshCopy(dir);
    const target = readlinkSync(path.join(copy.tempRoot, "a", "link.json"));
    expect(target).toBe(path.join("..", "b", "real.json"));
    expect(path.isAbsolute(target)).toBe(false);
    await copy.cleanup();
    await rm(dir, { recursive: true, force: true });
  });
});
