import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Shared harness for the Step 5 parity suites. Two principles, both from
// independent review:
// 1. Exit-site coverage is OBSERVED, not declared: the pinned legacy cli runs
//    under fixtures/observe-legacy-exit.mjs, which records the exact cli.mjs
//    line whose process.exit fired. Assertions compare that observation.
// 2. Filesystem parity is BYTE-EXACT. The only normalization applied to file
//    contents is a targeted, per-file replacement of known wall-clock fields
//    (governance "at", baseline/waiver "createdAt", plan "generatedAt",
//    approval "approvedAt", campaign "verifiedAt", OpenSpec "created" date).
//    Waiver expiry dates, config values, brand strings and every other byte
//    must match exactly. stdout/stderr comparison additionally canonicalizes
//    the intended brand substitution, the fixture root and wall-clock ISO
//    stamps.

export const LEGACY_CLI = path.resolve("node_modules/@avant-iconic/cleanroom/src/cli.mjs");
const OBSERVER = path.resolve("tests/policies/cleanroom/fixtures/observe-legacy-exit.mjs");
const FIXED_GIT_DATE = "2026-01-01T00:00:00Z";
const ISO_TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z/g;

export const roots: string[] = [];
export async function cleanupRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

/** Canonicalize command OUTPUT: intended brand substitution, fixture root, wall-clock stamps. */
export function canonical(text: string, root: string): string {
  return text
    .replaceAll("shipgate policy cleanroom", "greenroom")
    .replaceAll("ShipGate Cleanroom policy", "Green Room")
    .replaceAll(root, "<ROOT>")
    .replace(ISO_TS, "<TS>");
}

const STATE_WITH_CLOCK = /(^|\/)\.greenroom\/(governance\.jsonl|baseline\.json|cleanup-plan\.json|waivers\.json)$/;
const CAMPAIGN_RECORD = /(^|\/)\.greenroom\/campaigns\/[^/]+\.json$/;
const OPENSPEC_META = /(^|\/)openspec\/changes\/[^/]+\/\.openspec\.yaml$/;
const CLOCK_FIELD = /("(?:at|createdAt|generatedAt|approvedAt|verifiedAt)"\s*:\s*")[^"]*(")/g;

function normalizeFileBytes(rel: string, buf: Buffer): Buffer {
  if (STATE_WITH_CLOCK.test(rel) || CAMPAIGN_RECORD.test(rel)) {
    return Buffer.from(buf.toString("utf8").replace(CLOCK_FIELD, "$1<TS>$2"), "utf8");
  }
  if (OPENSPEC_META.test(rel)) {
    return Buffer.from(buf.toString("utf8").replace(/^created: .*$/m, "created: <DATE>"), "utf8");
  }
  return buf;
}

/** Byte-exact tree snapshot (minus .git); only known wall-clock fields normalized. */
export async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const rel = path.relative(root, full);
        out[rel] = normalizeFileBytes(rel, Buffer.from(await readFile(full))).toString("base64");
      }
    }
  }
  await walk(root);
  return out;
}

export function git(root: string, ...args: string[]) {
  return spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: FIXED_GIT_DATE, GIT_COMMITTER_DATE: FIXED_GIT_DATE },
  });
}

export async function addViolationNamed(root: string, a: string, b: string, message: string): Promise<void> {
  const dup = Array.from({ length: 30 }, (_, i) => `export const l${i} = "dup-${i}";`).join("\n") + "\n";
  await writeFile(path.join(root, "src", a), dup);
  await writeFile(path.join(root, "src", b), dup);
  git(root, "add", "-A");
  git(root, "commit", "-qm", message);
}

export const addViolation = (root: string) => addViolationNamed(root, "dup-a.ts", "dup-b.ts", "duplicate violation");
export const addSecondViolation = (root: string) => addViolationNamed(root, "dup-c.ts", "dup-d.ts", "second duplicate violation");

export async function initOpenSpec(root: string): Promise<void> {
  await mkdir(path.join(root, "openspec"), { recursive: true });
  git(root, "add", "-A");
  git(root, "commit", "-qm", "openspec init");
}

export type FixtureKind = "clean" | "violation";
export async function makeRoot(kind: FixtureKind): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "shipgate-cli-parity-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export const clean = true;\n");
  if (kind === "violation") await addViolation(root);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return root;
}

export type Run = { exitCode: number | null; stdout: string; stderr: string; observedSite: number | null };

/** Every legacy exit site observed across this test file's runs. */
export const OBSERVED_SITES = new Set<number>();

/** Run the legacy cli under the exit-site observer. */
export function runLegacy(args: string[], root: string): Run {
  const outFile = path.join(tmpdir(), `observe-${randomUUID()}.json`);
  const r = spawnSync(process.execPath, [OBSERVER, LEGACY_CLI, ...args, "--root", root], {
    encoding: "utf8",
    env: { ...process.env, OBSERVE_OUT: outFile },
  });
  const sites = JSON.parse(readFileSync(outFile, "utf8")) as { code: number; line: number }[];
  const observedSite = sites[0]?.line ?? null;
  if (observedSite !== null) OBSERVED_SITES.add(observedSite);
  return { exitCode: sites[0]?.code ?? r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", observedSite };
}

/** Parsed executable (non-comment) process.exit site line numbers in the pinned legacy cli. */
export async function legacyExecutableSites(): Promise<number[]> {
  const source = await readFile(LEGACY_CLI, "utf8");
  return source
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes("process.exit(") && !line.trim().startsWith("*"))
    .map(({ n }) => n);
}
