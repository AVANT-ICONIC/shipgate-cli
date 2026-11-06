import { writeFile, mkdir, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateCleanroom } from "../../../src/policies/cleanroom/migrate.js";
import { cleanupRoots, makeRoot, runLegacy } from "./step5ParityHarness.js";

// Spec issue #1 step 6: lossless migration of legacy Cleanroom state.

const MIGRATED_CONFIG = ".shipgate/policies/cleanroom.json";
const MIGRATED_STATE = ".shipgate/policies/cleanroom";
const MARKER = ".shipgate/policies/cleanroom/migration.json";
const LOCK = ".shipgate/policies/.cleanroom-migrate.lock";
const STAGING = ".shipgate/policies/.cleanroom-migrate.staging"; // legacy pre-journal name
const POLICIES = ".shipgate/policies";
/** Per-run staging dirs and journals of the journaled protocol. */
const stagingDirs = (root: string): string[] =>
  existsSync(path.join(root, POLICIES)) ? readdirSync(path.join(root, POLICIES)).filter((e) => e.startsWith(".cleanroom-migrate.staging")) : [];
const journalFiles = (root: string): string[] =>
  existsSync(path.join(root, POLICIES)) ? readdirSync(path.join(root, POLICIES)).filter((e) => e.startsWith(".cleanroom-migrate.journal-")) : [];
const currentStaging = (root: string): string => path.join(root, POLICIES, stagingDirs(root)[0]!);

/** Legacy repo with adopted policy: init --existing + baseline + a waiver + governance lines. */
async function legacyRepo(withViolation = true): Promise<string> {
  const root = await makeRoot(withViolation ? "violation" : "clean");
  expect(runLegacy(["init", "--existing"], root).exitCode).toBe(0);
  expect(runLegacy(["baseline"], root).exitCode).toBe(0);
  // Seed a governance history line (rebaseline entry) so preservation is tested.
  expect(runLegacy(["baseline", "--force", "--reason", "seed governance"], root).exitCode).toBe(0);
  return root;
}

/** Map of file bytes under root/rel, keyed relative to rel itself. */
function treeBytes(root: string, rel: string): Record<string, string> {
  const start = path.join(root, rel);
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(start, full)] = readFileSync(full).toString("base64");
    }
  };
  if (existsSync(start)) walk(start);
  return out;
}

afterEach(cleanupRoots);


describe("cleanroom migration adversarial regression (review rounds)", () => {
  it("two concurrent migrations: exactly one wins, the loser changes nothing", async () => {
    const root = await legacyRepo();
    const before = treeBytes(root, ".greenroom");
    const cliEntry = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
    const tsxBin = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
    const run = () =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise) => {
        const child = spawn(tsxBin, [cliEntry, "migrate", "cleanroom", "--root", root], { cwd: path.dirname(cliEntry) });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
      });
    const [a, b] = await Promise.all([run(), run()]);
    const results = [a, b];
    const winners = results.filter((r) => r.code === 0);
    const losers = results.filter((r) => r.code === 2);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    const loser = losers[0]!; expect(loser.stderr + loser.stdout).toContain("lock");
    // The winner's result is complete and undamaged by the loser.
    expect(JSON.parse(readFileSync(path.join(root, MARKER), "utf8")).status).toBe("completed");
    expect(existsSync(path.join(root, LOCK))).toBe(false);
    expect(existsSync(path.join(root, MIGRATED_CONFIG))).toBe(true);
    expect(stagingDirs(root)).toEqual([]);
    expect(journalFiles(root)).toEqual([]);
    expect(treeBytes(root, ".greenroom")).toEqual(before);
    // Re-run is a verified no-op: the winner's work is intact and consistent.
    expect(migrateCleanroom({ root }).exitCode).toBe(0);
  }, 180_000);

  it("refuses a symlinked destination ancestor and writes nothing through it", async () => {
    const root = await legacyRepo();
    const outside = await makeRoot("clean");
    await symlink(outside, path.join(root, ".shipgate"));
    const result = migrateCleanroom({ root });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("symlinked directory");
    expect(existsSync(path.join(outside, "policies"))).toBe(false);
    expect(existsSync(path.join(root, MARKER))).toBe(false);
  }, 60_000);

  it("an interrupted (verifying) marker is never reported as completed and deletes nothing", async () => {
    const root = await legacyRepo();
    const destDir = path.join(root, MIGRATED_STATE);
    await mkdir(destDir, { recursive: true });
    await writeFile(path.join(destDir, "migration.json"), JSON.stringify({ version: 1, status: "verifying", parityDigest: null }) + "\n");
    const destBefore = treeBytes(root, ".shipgate");
    const result = migrateCleanroom({ root });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("interrupted migration marker");
    expect(treeBytes(root, ".shipgate")).toEqual(destBefore); // no deletion of prior state
    expect(existsSync(path.join(root, ".greenroom", "baseline.json"))).toBe(true); // legacy untouched
  }, 60_000);

  it("re-run after destination tampering fails instead of reporting success", async () => {
    const root = await legacyRepo();
    expect(migrateCleanroom({ root }).exitCode).toBe(0);
    appendFileSync(path.join(root, MIGRATED_STATE, "waivers.json"), "tampered");
    const rerun = migrateCleanroom({ root });
    expect(rerun.exitCode).toBe(2);
    expect(rerun.stderr).toContain("no longer matches the recorded migration");
  }, 120_000);

  it("refuses malformed JSON in ANY legacy state file, not just named ones", async () => {
    const root = await legacyRepo();
    await writeFile(path.join(root, ".greenroom", "extra.json"), "{ not json");
    const before = treeBytes(root, ".greenroom");
    const result = migrateCleanroom({ root });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Malformed JSON");
    expect(treeBytes(root, ".greenroom")).toEqual(before);
    expect(existsSync(path.join(root, MIGRATED_STATE))).toBe(false);
  }, 60_000);

  it("refuses to commit when the legacy source changes during migration", async () => {
    const root = await legacyRepo();
    await writeFile(path.join(root, ".greenroom", "notes.txt"), "before\n");
    const result = migrateCleanroom({
      root,
      _hooks: { afterStaging: () => { appendFileSync(path.join(root, ".greenroom", "notes.txt"), "changed during migration\n"); } },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Legacy source changed during the migration");
    expect(existsSync(path.join(root, MIGRATED_STATE))).toBe(false);
    expect(existsSync(path.join(root, MARKER))).toBe(false);
    expect(existsSync(path.join(root, LOCK))).toBe(false);
  }, 120_000);

  it("dry run with a TypeScript ShipGate config writes nothing, not even the patch", async () => {
    const root = await legacyRepo();
    await writeFile(path.join(root, "shipgate.config.ts"), "export default { profile: 'node-cli' };\n");
    const before = treeBytes(root, ".");
    const result = migrateCleanroom({ root, dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Dry run: no changes were made.");
    expect(treeBytes(root, ".")).toEqual(before);
  }, 60_000);

  it("a TypeScript config patch is never written through a symlinked ancestor", async () => {
    const root = await legacyRepo();
    await writeFile(path.join(root, "shipgate.config.ts"), "export default { profile: 'node-cli' };\n");
    const outside = await makeRoot("clean");
    await symlink(outside, path.join(root, ".shipgate"));
    const result = migrateCleanroom({ root });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("symlinked directory");
    expect(existsSync(path.join(outside, "policies"))).toBe(false); // no patch through the symlink
  }, 60_000);

  it("any existing lock fails closed with a diagnosis; deliberate operator removal resumes", async () => {
    const root = await legacyRepo();
    await mkdir(path.dirname(path.join(root, LOCK)), { recursive: true });
    await writeFile(path.join(root, LOCK), JSON.stringify({ pid: 2147483647, startedAt: "2026-01-01T00:00:00Z" }) + "\n");
    const refused = migrateCleanroom({ root });
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("migration lock is present");
    expect(refused.stderr).toContain("no longer running");
    expect(refused.stderr).toContain("remove the lock file deliberately");
    expect(existsSync(path.join(root, LOCK))).toBe(true); // never reclaimed automatically
    // The operator confirms nothing is running and removes the lock; the run proceeds.
    rmSync(path.join(root, LOCK));
    expect(migrateCleanroom({ root }).exitCode).toBe(0);
    // A live holder is honored.
    const root2 = await legacyRepo();
    await mkdir(path.dirname(path.join(root2, LOCK)), { recursive: true });
    await writeFile(path.join(root2, LOCK), JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00Z" }) + "\n");
    const locked = migrateCleanroom({ root: root2 });
    expect(locked.exitCode).toBe(2);
    expect(locked.stderr).toContain("ALIVE");
    expect(existsSync(path.join(root2, MIGRATED_CONFIG))).toBe(false);
  }, 180_000);

  it("an external edit to shipgate.config.json during migration is a conflict, never overwritten", async () => {
    const root = await legacyRepo();
    await writeFile(path.join(root, "shipgate.config.json"), JSON.stringify({ profile: "node-cli" }) + "\n");
    const userEdit = JSON.stringify({ profile: "node-cli", userAdded: true }) + "\n";
    const result = migrateCleanroom({
      root,
      _hooks: { afterStaging: () => { writeFileSync(path.join(root, "shipgate.config.json"), userEdit); } },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("external edit");
    expect(readFileSync(path.join(root, "shipgate.config.json"), "utf8")).toBe(userEdit); // untouched
    expect(existsSync(path.join(root, MIGRATED_STATE))).toBe(true); // published state preserved, journaled
    expect(existsSync(path.join(root, MARKER))).toBe(false);
  }, 120_000);

  it("a failure after the config commit never touches the config, even bytes we wrote", async () => {
    const root = await legacyRepo();
    await writeFile(path.join(root, "shipgate.config.json"), JSON.stringify({ profile: "node-cli" }) + "\n");
    const userEdit = JSON.stringify({ profile: "node-cli", urgent: "user change" }) + "\n";
    const result = migrateCleanroom({
      root,
      _hooks: {
        afterPlacement: (r) => {
          // User edits the just-committed config AND placed state is
          // corrupted: the failure path must preserve everything published,
          // including the user's edit over our own committed bytes.
          writeFileSync(path.join(r, "shipgate.config.json"), userEdit);
          appendFileSync(path.join(r, ".shipgate", "policies", "cleanroom", "waivers.json"), "corrupted");
        },
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("interrupted after partial publication");
    expect(readFileSync(path.join(root, "shipgate.config.json"), "utf8")).toBe(userEdit);
    expect(readFileSync(path.join(root, MIGRATED_STATE, "waivers.json"), "utf8")).toContain("corrupted");
    expect(journalFiles(root).length).toBe(1);
    expect(existsSync(path.join(root, LOCK))).toBe(false);
  }, 120_000);

  it("pre-existing SHIPGATE_CLEANROOM_STATE_ROOT env values are restored after the run", async () => {
    const root = await legacyRepo();
    process.env.SHIPGATE_CLEANROOM_STATE_ROOT = "/preset/state";
    process.env.SHIPGATE_CLEANROOM_STATE_ROOT_FOR = "/preset/root";
    try {
      expect(migrateCleanroom({ root }).exitCode).toBe(0);
    } finally {
      expect(process.env.SHIPGATE_CLEANROOM_STATE_ROOT).toBe("/preset/state");
      expect(process.env.SHIPGATE_CLEANROOM_STATE_ROOT_FOR).toBe("/preset/root");
      delete process.env.SHIPGATE_CLEANROOM_STATE_ROOT;
      delete process.env.SHIPGATE_CLEANROOM_STATE_ROOT_FOR;
    }
  }, 120_000);

  it("a destination appearing in the placement window is never overwritten", async () => {
    const root = await legacyRepo();
    const result = migrateCleanroom({
      root,
      _hooks: {
        beforePlacement: (r) => {
          writeFileSync(path.join(r, MIGRATED_CONFIG), "OTHER WRITER\n");
        },
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Refusing to overwrite foreign content");
    expect(readFileSync(path.join(root, MIGRATED_CONFIG), "utf8")).toBe("OTHER WRITER\n"); // preserved
    expect(existsSync(path.join(root, MARKER))).toBe(false);
    expect(existsSync(path.join(root, LOCK))).toBe(false);
    expect(stagingDirs(root)).toEqual([]);
    expect(journalFiles(root)).toEqual([]);
  }, 120_000);

  it("a foreign file inside a freshly appearing destination dir survives rollback", async () => {
    const root = await legacyRepo();
    const result = migrateCleanroom({
      root,
      _hooks: {
        beforePlacement: (r) => {
          mkdirSync(path.join(r, MIGRATED_STATE), { recursive: true });
          writeFileSync(path.join(r, MIGRATED_STATE, "foreign.txt"), "not ours\n");
        },
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Refusing to overwrite foreign content");
    expect(readFileSync(path.join(root, MIGRATED_STATE, "foreign.txt"), "utf8")).toBe("not ours\n"); // not deleted
    expect(existsSync(path.join(root, LOCK))).toBe(false);
  }, 120_000);

  it("marker counts are record counts, not top-level metadata keys", async () => {
    const root = await legacyRepo();
    expect(migrateCleanroom({ root }).exitCode).toBe(0);
    const marker = JSON.parse(readFileSync(path.join(root, MARKER), "utf8"));
    const registry = JSON.parse(readFileSync(path.join(root, ".greenroom", "registry.json"), "utf8"));
    const generated = JSON.parse(readFileSync(path.join(root, ".greenroom", "generated.json"), "utf8"));
    const expectedRegistry = Object.keys(registry.responsibilities ?? {}).length + Object.keys(registry.components ?? {}).length;
    const expectedGenerated = Object.keys(generated.artifacts ?? {}).length;
    expect(marker.sourceInventory.counts.registryEntries).toBe(expectedRegistry);
    expect(marker.sourceInventory.counts.generatedArtifacts).toBe(expectedGenerated);
    // An empty registry reports zero records (previously 3 metadata keys).
    const { inventoryState } = await import("../../../src/policies/cleanroom/migrate.js");
    const emptyRoot = await makeRoot("clean");
    await mkdir(path.join(emptyRoot, ".greenroom"), { recursive: true });
    await writeFile(path.join(emptyRoot, ".greenroom", "registry.json"), JSON.stringify({ version: 1, responsibilities: {}, components: {} }));
    await writeFile(path.join(emptyRoot, ".greenroom", "generated.json"), JSON.stringify({ version: 1, artifacts: {} }));
    const inv = inventoryState(emptyRoot, ".greenroom.json", ".greenroom");
    expect(inv.counts.registryEntries).toBe(0);
    expect(inv.counts.generatedArtifacts).toBe(0);
  }, 120_000);

  it("the comparator is probed and recorded; a foreign or unversioned executable is refused", async () => {
    const root = await legacyRepo();
    const fake = path.join(root, "fake-greenroom.mjs");
    await writeFile(fake, "console.log('9.9.9');\n");
    const wrong = migrateCleanroom({ root, legacyCli: fake });
    expect(wrong.exitCode).toBe(2);
    expect(wrong.stderr).toContain("1.1.x");
    await writeFile(fake, "console.log('no version here');\n");
    const unversioned = migrateCleanroom({ root, legacyCli: fake });
    expect(unversioned.exitCode).toBe(2);
    expect(unversioned.stderr).toContain("did not report a version");
    expect(existsSync(path.join(root, MIGRATED_STATE))).toBe(false); // refused before any write

    expect(migrateCleanroom({ root }).exitCode).toBe(0);
    const marker = JSON.parse(readFileSync(path.join(root, MARKER), "utf8"));
    expect(marker.tools.cleanroomPolicy).toBe("1.1.0");
    expect(marker.tools.comparator.version).toBe("1.1.0");
    expect(marker.tools.comparator.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);

  it("an edit injected at the config commit is caught by the move-aside verify", async () => {
    const root = await legacyRepo();
    await writeFile(path.join(root, "shipgate.config.json"), JSON.stringify({ profile: "node-cli" }) + "\n");
    const userEdit = JSON.stringify({ profile: "node-cli", injected: "at commit" }) + "\n";
    const result = migrateCleanroom({
      root,
      _hooks: { beforeConfigCommit: (r) => { writeFileSync(path.join(r, "shipgate.config.json"), userEdit); } },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("external edit");
    expect(readFileSync(path.join(root, "shipgate.config.json"), "utf8")).toBe(userEdit); // edit preserved
    // Published state is preserved and journaled, never rolled back.
    expect(existsSync(path.join(root, MIGRATED_STATE))).toBe(true);
    expect(journalFiles(root).length).toBe(1);
    expect(existsSync(path.join(root, ".shipgate", "policies", ".cleanroom-migrate.config-backup"))).toBe(false);
    expect(existsSync(path.join(root, LOCK))).toBe(false);
  }, 120_000);

  it("a config appearing at the final create is a conflict, never an overwrite", async () => {
    const root = await legacyRepo(); // no shipgate.config.json: create case
    const foreign = JSON.stringify({ foreign: true }) + "\n";
    const result = migrateCleanroom({
      root,
      _hooks: { beforeConfigCommit: (r) => { writeFileSync(path.join(r, "shipgate.config.json"), foreign); } },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("appeared during the migration");
    expect(readFileSync(path.join(root, "shipgate.config.json"), "utf8")).toBe(foreign); // preserved
    expect(existsSync(path.join(root, MIGRATED_STATE))).toBe(true); // published state preserved, journaled
  }, 120_000);

  it("a failed merge copy preserves the original at the backup path; resume restores and completes", async () => {
    const root = await legacyRepo();
    const original = JSON.stringify({ profile: "node-cli", keep: "original" }) + "\n";
    await writeFile(path.join(root, "shipgate.config.json"), original);
    const result = migrateCleanroom({
      root,
      _hooks: {
        beforeConfigCommit: (r) => {
          // Force the final copy to fail after the original was moved aside.
          const staged = path.join(currentStaging(r), "shipgate.config.json");
          rmSync(staged, { force: true });
          mkdirSync(staged);
        },
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("interrupted after partial publication");
    // The read failed before any move-aside: the original config is untouched,
    // no backup exists, published state and the journal remain.
    expect(readFileSync(path.join(root, "shipgate.config.json"), "utf8")).toBe(original);
    expect(existsSync(path.join(root, ".shipgate", "policies", ".cleanroom-migrate.config-backup"))).toBe(false);
    expect(existsSync(path.join(root, MIGRATED_STATE))).toBe(true);
    expect(journalFiles(root).length).toBe(1);
    expect(existsSync(path.join(root, LOCK))).toBe(false);
    // Re-run with healthy staging completes: published pieces are adopted.
    const resumed = migrateCleanroom({ root });
    expect(resumed.exitCode).toBe(0);
    const merged = JSON.parse(readFileSync(path.join(root, "shipgate.config.json"), "utf8")) as Record<string, unknown>;
    expect(merged.keep).toBe("original");
    expect((merged.policies as { cleanroom: { enabled: boolean } }).cleanroom.enabled).toBe(true);
    expect(journalFiles(root)).toEqual([]);
  }, 240_000);

  it("a partial destination with no journaled publication is ambiguous, never adopted", async () => {
    const root = await legacyRepo();
    // Bytes alone never prove ownership: a destination that no journal
    // explains is foreign state, even when its content matches the source.
    mkdirSync(path.join(root, MIGRATED_STATE), { recursive: true });
    writeFileSync(path.join(root, MIGRATED_CONFIG), readFileSync(path.join(root, ".greenroom.json")));
    rmSync(path.join(root, MIGRATED_STATE), { recursive: true, force: true });
    const result = migrateCleanroom({ root });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Ambiguous destination");
    expect(readFileSync(path.join(root, MIGRATED_CONFIG), "utf8")).toBe(readFileSync(path.join(root, ".greenroom.json"), "utf8")); // preserved
  }, 120_000);

  it("an empty destination directory without a journaled reservation is preserved, not replaced", async () => {
    const root = await legacyRepo();
    const result = migrateCleanroom({
      root,
      _hooks: { beforePlacement: (r) => { mkdirSync(path.join(r, MIGRATED_STATE), { recursive: true }); } },
    });
    // No journal proves the empty dir is our reservation: it may be foreign,
    // so it is preserved and reported; removal is a deliberate operator act.
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("no journaled reservation");
    expect(existsSync(path.join(root, MIGRATED_STATE))).toBe(true);
    rmSync(path.join(root, MIGRATED_STATE), { recursive: true });
    const resumed = migrateCleanroom({ root });
    expect(resumed.exitCode).toBe(0);
    const placed = treeBytes(root, MIGRATED_STATE);
    delete placed["migration.json"]; // the marker is migration metadata, not state
    expect(placed).toEqual(treeBytes(root, ".greenroom"));
  }, 240_000);

  it("foreign content blocking the state rename is never recursively deleted", async () => {
    const root = await legacyRepo();
    const foreignDir = path.join(root, MIGRATED_STATE);
    const result = migrateCleanroom({
      root,
      _hooks: {
        beforePlacement: (r) => {
          // Land inside the window after our mkdir-owned dir exists: the
          // rename fails ENOTEMPTY, rollback must not take the foreign file.
          const orig = path.join(r, MIGRATED_STATE);
          mkdirSync(orig, { recursive: true });
          writeFileSync(path.join(orig, "foreign.txt"), "not ours\n");
        },
      },
    });
    expect(result.exitCode).toBe(2);
    expect(readFileSync(path.join(foreignDir, "foreign.txt"), "utf8")).toBe("not ours\n"); // preserved
    expect(existsSync(path.join(root, MARKER))).toBe(false);
  }, 120_000);

  it("a foreign write at the config refill keeps its path; the original is kept at a unique backup", async () => {
    const root = await legacyRepo();
    const original = JSON.stringify({ profile: "node-cli" }) + "\n";
    await writeFile(path.join(root, "shipgate.config.json"), original);
    const foreign = JSON.stringify({ foreign: "newer edit" }) + "\n";
    const result = migrateCleanroom({
      root,
      _hooks: {
        beforeConfigRefill: (r) => {
          // The original is aside; a foreign write lands at the path exactly
          // at the EXCL refill.
          writeFileSync(path.join(r, "shipgate.config.json"), foreign);
        },
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("left untouched at shipgate.config.json");
    // The foreign file keeps its path; the original survives at the unique
    // backup named in the error; published state is preserved and journaled.
    expect(readFileSync(path.join(root, "shipgate.config.json"), "utf8")).toBe(foreign);
    const backups = readdirSync(root).filter((e) => e.startsWith("shipgate.config.json.migration-backup-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(path.join(root, backups[0]!), "utf8")).toBe(original);
    expect(existsSync(path.join(root, MIGRATED_STATE))).toBe(true);
    expect(journalFiles(root).length).toBe(1);
  }, 120_000);

  it("losing the lock mid-migration freezes without writes or cleanup", async () => {
    const root = await legacyRepo();
    const result = migrateCleanroom({
      root,
      _hooks: {
        afterStaging: () => {
          rmSync(path.join(root, LOCK), { force: true }); // stolen lock
        },
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("lock lost");
    expect(existsSync(path.join(root, MARKER))).toBe(false);
    expect(existsSync(path.join(root, MIGRATED_CONFIG))).toBe(false); // nothing published after the loss
    // Freeze means no cleanup: staging and journal remain for the next run,
    // which adopts the journal, removes the recorded scratch, and completes.
    expect(stagingDirs(root).length).toBe(1);
    expect(journalFiles(root).length).toBe(1);
    const resumed = migrateCleanroom({ root });
    expect(resumed.exitCode).toBe(0);
    expect(stagingDirs(root)).toEqual([]);
    expect(journalFiles(root)).toEqual([]);
  }, 240_000);

  it("an explicit --legacy-cli path is used; a missing one fails before any write", async () => {
    const root = await legacyRepo();
    const before = treeBytes(root, ".");
    const bad = migrateCleanroom({ root, legacyCli: "/nonexistent/greenroom-cli.mjs" });
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain("--legacy-cli path does not exist");
    expect(treeBytes(root, ".")).toEqual(before);
    const legacyCli = fileURLToPath(new URL("../../../node_modules/@avant-iconic/cleanroom/src/cli.mjs", import.meta.url));
    expect(migrateCleanroom({ root, legacyCli }).exitCode).toBe(0);
  }, 120_000);
});

describe("cleanroom migration (spec Step 6)", () => {
  it("dry-run validates and plans without changing anything", async () => {
    const root = await legacyRepo();
    const before = treeBytes(root, ".");
    const result = migrateCleanroom({ root, dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Dry run: no changes were made.");
    expect(existsSync(path.join(root, ".shipgate"))).toBe(false);
    expect(treeBytes(root, ".")).toEqual(before);
  }, 60_000);

  it("migrates byte-for-byte, verifies parity, preserves governance history, keeps legacy", async () => {
    const root = await legacyRepo();
    const result = migrateCleanroom({ root });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    // Byte-for-byte: config and every state file.
    expect(readFileSync(path.join(root, MIGRATED_CONFIG))).toEqual(readFileSync(path.join(root, ".greenroom.json")));
    const legacyState = treeBytes(root, ".greenroom");
    const migratedState = treeBytes(root, MIGRATED_STATE);
    for (const [rel, bytes] of Object.entries(legacyState)) {
      expect(migratedState[rel], `state file ${rel} byte-identical`).toBe(bytes);
    }
    // The only extra file in the migrated state is the migration marker.
    expect(Object.keys(migratedState).filter((k) => !(k in legacyState)).sort()).toEqual(["migration.json"]);
    // Exact baseline / registry / waivers bytes are covered above; governance
    // history lines preserved one-for-one:
    const legacyGov = readFileSync(path.join(root, ".greenroom", "governance.jsonl"), "utf8");
    expect(readFileSync(path.join(root, MIGRATED_STATE, "governance.jsonl"), "utf8")).toBe(legacyGov);
    // Marker finalized with parity digest; legacy state untouched.
    const marker = JSON.parse(readFileSync(path.join(root, MARKER), "utf8")) as { status: string; parityDigest: string | null };
    expect(marker.status).toBe("completed");
    expect(marker.parityDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(path.join(root, ".greenroom"))).toBe(true);
    expect(existsSync(path.join(root, LOCK))).toBe(false);
    expect(stagingDirs(root)).toEqual([]);
    expect(journalFiles(root)).toEqual([]);
    // Config created (no ShipGate config existed).
    const config = JSON.parse(readFileSync(path.join(root, "shipgate.config.json"), "utf8")) as { policies: { cleanroom: { enabled: boolean } } };
    expect(config.policies.cleanroom.enabled).toBe(true);
  }, 120_000);

  it("re-run of a completed identical migration is a no-op; changed source is a conflict", async () => {
    const root = await legacyRepo();
    expect(migrateCleanroom({ root }).exitCode).toBe(0);
    const again = migrateCleanroom({ root });
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("No-op");
    // Change the legacy source after migration: conflict, exit 2, state intact.
    await writeFile(path.join(root, ".greenroom", "waivers.json"), JSON.stringify({ waivers: [] }));
    const conflict = migrateCleanroom({ root });
    expect(conflict.exitCode).toBe(2);
    expect(conflict.stderr).toContain("changed after the completed migration");
    expect(existsSync(path.join(root, MARKER))).toBe(true);
  }, 120_000);

  it("refuses malformed JSON and malformed governance JSONL", async () => {
    const root = await legacyRepo();
    await writeFile(path.join(root, ".greenroom", "waivers.json"), "{ not json");
    const bad = migrateCleanroom({ root });
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain("Malformed JSON");
    expect(existsSync(path.join(root, ".shipgate"))).toBe(false);

    const root2 = await legacyRepo();
    await writeFile(path.join(root2, ".greenroom", "governance.jsonl"), '{"ok":1}\nnot-json\n');
    const bad2 = migrateCleanroom({ root: root2 });
    expect(bad2.exitCode).toBe(2);
    expect(bad2.stderr).toContain("Malformed JSONL");
    expect(existsSync(path.join(root2, ".shipgate"))).toBe(false);
  }, 120_000);

  it("refuses an ambiguous or pre-existing destination", async () => {
    const root = await legacyRepo();
    await mkdir(path.join(root, MIGRATED_STATE), { recursive: true });
    const result = migrateCleanroom({ root });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Ambiguous destination");
  }, 60_000);

  it("recovers interrupted staging but refuses an active lock", async () => {
    const root = await legacyRepo();
    await mkdir(path.join(root, STAGING, "junk"), { recursive: true });
    const recovered = migrateCleanroom({ root });
    expect(recovered.exitCode).toBe(0);
    expect(existsSync(path.join(root, STAGING))).toBe(false);

    const root2 = await legacyRepo();
    await mkdir(path.dirname(path.join(root2, LOCK)), { recursive: true });
    await writeFile(path.join(root2, LOCK), JSON.stringify({ pid: 1 }));
    const locked = migrateCleanroom({ root: root2 });
    expect(locked.exitCode).toBe(2);
    expect(locked.stderr).toContain("migration lock is present");
    expect(existsSync(path.join(root2, MIGRATED_CONFIG))).toBe(false);
  }, 120_000);

  it("refuses symlinks escaping the repository", async () => {
    const root = await legacyRepo();
    await symlink("/etc/hostname", path.join(root, ".greenroom", "escape"));
    const result = migrateCleanroom({ root });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Refusing to migrate a symlink");
    expect(existsSync(path.join(root, ".shipgate"))).toBe(false);
  }, 60_000);

  it("merges only policies.cleanroom into a JSON config and preserves unrelated values", async () => {
    const root = await legacyRepo();
    await writeFile(path.join(root, "shipgate.config.json"), JSON.stringify({ profile: "node-cli", custom: { keep: [1, 2] } }, null, 2) + "\n");
    const result = migrateCleanroom({ root });
    expect(result.exitCode).toBe(0);
    const config = JSON.parse(readFileSync(path.join(root, "shipgate.config.json"), "utf8")) as Record<string, unknown>;
    expect(config.profile).toBe("node-cli");
    expect(config.custom).toEqual({ keep: [1, 2] });
    expect((config.policies as { cleanroom: { enabled: boolean } }).cleanroom.enabled).toBe(true);
  }, 120_000);

  it("writes a proposed patch and returns 2 for a TypeScript ShipGate config", async () => {
    const root = await legacyRepo();
    await writeFile(path.join(root, "shipgate.config.ts"), "export default { profile: 'node-cli' };\n");
    const result = migrateCleanroom({ root });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("proposed patch");
    const patch = JSON.parse(readFileSync(path.join(root, ".shipgate/policies/cleanroom.config-patch.json"), "utf8")) as { policies: { cleanroom: { enabled: boolean } } };
    expect(patch.policies.cleanroom.enabled).toBe(true);
    // No migration happened yet.
    expect(existsSync(path.join(root, MIGRATED_CONFIG))).toBe(false);
    expect(existsSync(path.join(root, MARKER))).toBe(false);
  }, 60_000);

  it("fails cleanly (spec 6.10) when the staged copy fails re-inventory", async () => {
    const root = await legacyRepo();
    await writeFile(path.join(root, "shipgate.config.json"), JSON.stringify({ profile: "node-cli" }) + "\n");
    const beforeConfig = readFileSync(path.join(root, "shipgate.config.json"));
    const before = treeBytes(root, ".greenroom");
    const result = migrateCleanroom({
      root,
      _hooks: { afterStaging: (stagingAbs) => { appendFileSync(path.join(stagingAbs, ".shipgate", "policies", "cleanroom", "skills", "repo-hygiene", "SKILL.md"), "tampered"); } },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("before any publication");
    expect(result.stderr).toContain("byte hashes or record counts");
    // Legacy untouched; no destination, staging, journal, lock, or marker left
    // behind; the pre-existing config is byte-exact (never touched).
    expect(treeBytes(root, ".greenroom")).toEqual(before);
    expect(existsSync(path.join(root, MIGRATED_CONFIG))).toBe(false);
    expect(existsSync(path.join(root, MIGRATED_STATE))).toBe(false);
    expect(stagingDirs(root)).toEqual([]);
    expect(journalFiles(root)).toEqual([]);
    expect(existsSync(path.join(root, LOCK))).toBe(false);
    expect(readFileSync(path.join(root, "shipgate.config.json"))).toEqual(beforeConfig);
  }, 120_000);

  it("placed state is preserved and journaled when verification fails after publication; resume byte-verifies", async () => {
    const root = await legacyRepo();
    await writeFile(path.join(root, "shipgate.config.json"), JSON.stringify({ profile: "node-cli", keep: true }) + "\n");
    const before = treeBytes(root, ".greenroom");
    const result = migrateCleanroom({
      root,
      // Corrupt the PLACED migrated state after placement but before the
      // commit marker: destination verification must catch it, and the
      // published pieces must be preserved and journaled, never rolled back.
      _hooks: { afterPlacement: (r) => { appendFileSync(path.join(r, ".shipgate", "policies", "cleanroom", "waivers.json"), "corrupted"); } },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("interrupted after partial publication");
    expect(result.stderr).toContain("preserved and journaled");
    expect(treeBytes(root, ".greenroom")).toEqual(before);
    // Nothing was unpublished: the (corrupted) destination and journal remain;
    // the already-committed config merge stays; staging and lock are gone.
    expect(readFileSync(path.join(root, MIGRATED_STATE, "waivers.json"), "utf8")).toContain("corrupted");
    expect(journalFiles(root).length).toBe(1);
    expect(stagingDirs(root)).toEqual([]);
    expect(existsSync(path.join(root, LOCK))).toBe(false);
    const config = JSON.parse(readFileSync(path.join(root, "shipgate.config.json"), "utf8")) as Record<string, unknown>;
    expect(config.keep).toBe(true);
    expect((config.policies as { cleanroom: unknown }).cleanroom).toBeDefined();
    // A blind re-run refuses: the corrupted bytes do not verify.
    const blind = migrateCleanroom({ root });
    expect(blind.exitCode).toBe(2);
    expect(blind.stderr).toContain("differs from the verified staged copy");
    // After the operator repairs the destination from the untouched legacy
    // state, the resume completes byte-verified and cleans up.
    writeFileSync(path.join(root, MIGRATED_STATE, "waivers.json"), readFileSync(path.join(root, ".greenroom", "waivers.json")));
    const resumed = migrateCleanroom({ root });
    expect(resumed.exitCode).toBe(0);
    expect(journalFiles(root)).toEqual([]);
    expect(stagingDirs(root)).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(root, MARKER), "utf8")).status).toBe("completed");
  }, 240_000);

  it("after migration the policy dispatcher reads migrated state and check passes", async () => {
    const root = await legacyRepo(false);
    expect(migrateCleanroom({ root }).exitCode).toBe(0);
    const { runCleanroomCli } = await import("../../../src/policies/cleanroom/cli.js");
    const check = runCleanroomCli(["check", "--root", root], { cwd: root });
    expect(check.exitCode).toBe(0);
  }, 120_000);
});

describe("cleanroom migration real-crash recovery (reviewed protocol)", () => {
  const CRASH_ENV = "SHIPGATE_CLEANROOM_MIGRATE_CRASH_AT";
  const boundaries = [
    "afterLock",
    "afterJournalCreate",
    "afterStagingCreated",
    "afterSnapshot",
    "afterParity",
    "beforePublishConfig",
    "afterPublishConfig",
    "afterStateReservation",
    "afterPublishState",
    "beforeConfigCommit",
    "afterConfigCommit",
    "beforeMarkerCommit",
    "afterMarkerCommit",
  ];

  const runChild = (root: string, env: Record<string, string>) =>
    new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolvePromise) => {
      const cliEntry = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
      const child = spawn(process.execPath, ["--import", "tsx", cliEntry, "migrate", "cleanroom", "--root", root], {
        cwd: path.dirname(cliEntry),
        env: { ...process.env, ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
    });

  for (const boundary of boundaries) {
    it(`genuine SIGKILL crash at ${boundary}: fail-closed lock, operator resume completes byte-verified`, async () => {
      const root = await legacyRepo();
      const before = treeBytes(root, ".greenroom");
      const crashed = await runChild(root, { [CRASH_ENV]: boundary });
      expect(crashed.signal).toBe("SIGKILL"); // genuine process death, not a hook
      expect(treeBytes(root, ".greenroom")).toEqual(before); // legacy state untouched

      if (boundary === "afterMarkerCommit") {
        // The commit point landed; the marker-complete re-run verifies the
        // destination, clears migrator scratch (including the stale lock) and
        // no-ops.
        expect(existsSync(path.join(root, MARKER))).toBe(true);
      } else {
        expect(existsSync(path.join(root, MARKER))).toBe(false);
        // A naive re-run fails closed on the stale lock, with a diagnosis.
        expect(existsSync(path.join(root, LOCK))).toBe(true);
        const refused = migrateCleanroom({ root });
        expect(refused.exitCode).toBe(2);
        expect(refused.stderr).toContain("migration lock is present");
        expect(refused.stderr).toContain("no longer running");
        expect(existsSync(path.join(root, MARKER))).toBe(false); // no commit from the refusal
        // Deliberate operator recovery: remove the lock, then re-run.
        rmSync(path.join(root, LOCK));
      }

      const resumed = migrateCleanroom({ root });
      expect(resumed.exitCode).toBe(0);
      expect(resumed.stderr).toBe("");
      // Byte-for-byte result, whatever boundary the crash hit.
      const placed = treeBytes(root, MIGRATED_STATE);
      delete placed["migration.json"]; // the marker is migration metadata, not state
      expect(placed).toEqual(before);
      expect(readFileSync(path.join(root, MIGRATED_CONFIG))).toEqual(readFileSync(path.join(root, ".greenroom.json")));
      expect(JSON.parse(readFileSync(path.join(root, MARKER), "utf8")).status).toBe("completed");
      expect(stagingDirs(root)).toEqual([]);
      expect(journalFiles(root)).toEqual([]);
      expect(existsSync(path.join(root, LOCK))).toBe(false);
    }, 300_000);
  }

  it("a crash between a journal begin and its done is reconciled by byte-verification", async () => {
    // afterPublishConfig kills the process after the done record; this test
    // kills INSIDE the publish window (begin recorded, done not) by crashing
    // at the reservation boundary, then verifies the empty reservation is
    // adopted via the journaled identity and publication completes.
    const root = await legacyRepo();
    const crashed = await runChild(root, { [CRASH_ENV]: "afterStateReservation" });
    expect(crashed.signal).toBe("SIGKILL");
    // The reservation (an empty dir) exists, journaled with its identity.
    expect(existsSync(path.join(root, MIGRATED_STATE))).toBe(true);
    expect(readdirSync(path.join(root, MIGRATED_STATE))).toEqual([]);
    const journal = JSON.parse(
      readFileSync(path.join(root, POLICIES, journalFiles(root)[0]!), "utf8"),
    ) as { steps: { op: string; status: string }[] };
    expect(journal.steps.some((s) => s.op === "state-reservation" && s.status === "done")).toBe(true);
    expect(journal.steps.some((s) => s.op === "publish-state" && s.status === "done")).toBe(false);
    rmSync(path.join(root, LOCK));
    const resumed = migrateCleanroom({ root });
    expect(resumed.exitCode).toBe(0);
    const placed = treeBytes(root, MIGRATED_STATE);
    delete placed["migration.json"];
    expect(placed).toEqual(treeBytes(root, ".greenroom"));
  }, 300_000);
});
