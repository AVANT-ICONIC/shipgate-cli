import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  ".next",
  ".shipgate",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
  "playwright-report",
  "test-results",
  ".env",
  ".env.*"
];

function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/$/, "");
}

function matchesPattern(rel: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return rel.startsWith(prefix) || rel.includes(`/${prefix}`);
  }

  return rel === pattern ||
    rel.startsWith(`${pattern}/`) ||
    rel.endsWith(`/${pattern}`) ||
    rel.includes(`/${pattern}/`);
}

function shouldExclude(relativePath: string, extraExcludes: string[]): boolean {
  const rel = normalize(relativePath);
  if (!rel) return false;

  const all = [...DEFAULT_EXCLUDES, ...extraExcludes].map(normalize);

  return all.some((pattern) => matchesPattern(rel, pattern));
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  return { ok: result.status === 0, stdout: typeof result.stdout === "string" ? result.stdout : "" };
}

/**
 * What the project's own .gitignore excludes, as repo-relative paths.
 *
 * WHY. Without this, a fresh copy carries every untracked artefact lying beside
 * the repository and then runs the project's checks over it.
 *
 * MEASURED 2026-09-17 in apex-nexus: `.apex/` is gitignored scratch holding two
 * vendored checkouts. The fresh copy ran 1,144 test files where the project has
 * 988, and the extra 156 belonged to somebody else's project.
 *
 * `--directory` collapses a vendored tree to one entry, so a 300 MB checkout
 * costs one line rather than thousands. Outside a repository this is empty and
 * the copy behaves as it always did.
 */
export function gitIgnoredPaths(projectRoot: string): Set<string> {
  const { ok, stdout } = git(projectRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory"
  ]);
  if (!ok) return new Set();
  return new Set(
    stdout
      .split("\n")
      .map((line) => normalize(line.trim()))
      .filter(Boolean)
  );
}

/**
 * Give the fresh copy a working git repository without copying the object store.
 *
 * WHY A FRESH COPY NEEDS `.git` AT ALL. `.git` is in DEFAULT_EXCLUDES above,
 * and for most projects that is invisible. For a project whose checks ask git
 * anything it is fatal, and the failure does not say so: the commands simply
 * print `fatal: not a git repository` and the checks fail as if the code were
 * broken.
 *
 * MEASURED 2026-09-17 in apex-nexus: 25 of its tests failed in the fresh copy
 * and passed everywhere else. Every one of them interrogates the repository --
 * `apex_branches`, `apex_diff`, `apex_log`, `apex_worktrees`,
 * `every tracked .mjs parses` (which is `git ls-files`), `no lane marker is
 * tracked on master`. ShipGate reported "1 of 3 checks failed from a fresh
 * copy", which reads as a broken project rather than as a missing `.git`.
 *
 * WHY NOT JUST COPY IT. apex-nexus's `.git` is 8.7 GB. Copying that per verify
 * is not a thing anyone would run twice.
 *
 * `git clone --local --shared --no-checkout` writes a `.git` of a few kilobytes
 * whose objects are BORROWED from the source through `objects/info/alternates`,
 * then `read-tree` fills the index from HEAD without touching the working tree
 * that was just copied in. The result answers `git ls-files`, `git log`,
 * `git diff` and `git branch` exactly as a clone would, for the price of a
 * directory listing.
 *
 * The borrow is safe because this copy is ephemeral and read-only: nothing in a
 * verification run writes objects, and the source outlives the temp directory.
 *
 * Every failure here is soft. A project that is not a repository, a machine
 * with no git, a clone that refuses for any reason: the copy is made without
 * `.git`, which is exactly what it always was.
 */
function seedGitRepository(projectRoot: string, tempRoot: string): boolean {
  const isRepo = spawnSync("git", ["-C", projectRoot, "rev-parse", "--git-dir"], { stdio: "ignore" });
  if (isRepo.status !== 0) return false;

  const clone = spawnSync(
    "git",
    ["clone", "--local", "--shared", "--no-checkout", "--quiet", projectRoot, tempRoot],
    { stdio: "ignore" }
  );
  if (clone.status !== 0) return false;

  // The working tree is copied in separately; this only makes the index agree
  // with HEAD, so tracked files read as tracked instead of as untracked.
  const readTree = spawnSync("git", ["-C", tempRoot, "read-tree", "HEAD"], { stdio: "ignore" });
  if (readTree.status !== 0) return false;

  // THE COPY'S REMOTES MUST BE THE PROJECT'S REMOTES.
  //
  // `git clone --local` points origin at the source DIRECTORY, so the copy's
  // origin is a path on this machine. A project that checks where its own code
  // would survive from reads that as a local-only remote and is right to fail:
  // apex-nexus asserts exactly that, in
  // "the vendored harness is not its own git -- it rides this repository's
  // origin", because its fleet scripts survive a dead Mac only through an
  // off-disk origin.
  //
  // A fresh clone of the project has the project's remotes. This makes that
  // true. It stays a copy: no fetch, no push, nothing is contacted.
  const remotes = git(projectRoot, ["remote", "-v"]);
  if (remotes.ok) {
    spawnSync("git", ["-C", tempRoot, "remote", "remove", "origin"], { stdio: "ignore" });
    const seen = new Set<string>();
    for (const line of remotes.stdout.split("\n")) {
      const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
      const name = match?.[1];
      const url = match?.[2];
      if (!name || !url || seen.has(name)) continue;
      seen.add(name);
      spawnSync("git", ["-C", tempRoot, "remote", "add", name, url], { stdio: "ignore" });
    }
  }
  return true;
}

export type FreshCopyResult = {
  tempRoot: string;
  /** Whether the copy carries a working `.git`. False is a valid answer, never a silent one. */
  hasGit: boolean;
  cleanup(): Promise<void>;
};

export async function createFreshCopy(
  projectRoot: string,
  extraExcludes: string[] = []
): Promise<FreshCopyResult> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "shipgate-"));

  // Before the working tree lands, so the clone has an empty directory.
  const hasGit = seedGitRepository(projectRoot, tempRoot);

  // A project's own .gitignore is the authority on what is not its source. An
  // untracked file that git does NOT ignore is still copied: work in progress
  // is what a verification run exists to judge.
  const ignored = gitIgnoredPaths(projectRoot);

  await cp(projectRoot, tempRoot, {
    recursive: true,
    force: true,
    // A SYMLINK MUST ARRIVE AS THE SYMLINK IT WAS.
    //
    // Node's cp resolves relative symlinks to absolute paths unless told not
    // to. A repository that links one vendored file to its sibling copy gets a
    // link to an absolute path on the machine the copy was made on, which is
    // not what the repository contains and does not survive being moved.
    // apex-nexus fails on exactly that: "pool-registry.json links to
    // /Users/.../ops/fleet/queue-ceo/pool-registry.json, which is not a
    // relative path into a sibling fleet directory".
    verbatimSymlinks: true,
    filter: (source) => {
      const relativePath = path.relative(projectRoot, source);
      if (ignored.has(normalize(relativePath))) return false;
      return !shouldExclude(relativePath, extraExcludes);
    }
  });

  return {
    tempRoot,
    hasGit,
    async cleanup() {
      await rm(tempRoot, { recursive: true, force: true });
    }
  };
}

export { DEFAULT_EXCLUDES, shouldExclude };
