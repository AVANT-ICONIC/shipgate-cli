import { writeFile, mkdir, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateCleanroom } from "../../../src/policies/cleanroom/migrate.js";
import { cleanupRoots, makeRoot, runLegacy } from "./step5ParityHarness.js";

// Spec issue #1 step 6: lossless migration of legacy Cleanroom state.

const MIGRATED_CONFIG = ".shipgate/policies/cleanroom.json";
const MIGRATED_STATE = ".shipgate/policies/cleanroom";
const MARKER = ".shipgate/policies/cleanroom/migration.json";
const LOCK = ".shipgate/policies/.cleanroom-migrate.lock";
const STAGING = ".shipgate/policies/.cleanroom-migrate.staging";

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
    expect(existsSync(path.join(root, STAGING))).toBe(false);
    expect(existsSync(path.join(root, MIGRATED_CONFIG))).toBe(true);
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

  it("a stale lock whose owner pid is dead is recovered; a live one is honored", async () => {
    const root = await legacyRepo();
    await mkdir(path.dirname(path.join(root, LOCK)), { recursive: true });
    await writeFile(path.join(root, LOCK), JSON.stringify({ pid: 2147483647, startedAt: "2026-01-01T00:00:00Z" }) + "\n");
    const recovered = migrateCleanroom({ root });
    expect(recovered.exitCode).toBe(0);
    expect(existsSync(path.join(root, LOCK))).toBe(false);
  }, 120_000);

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
    expect(existsSync(path.join(root, MIGRATED_STATE))).toBe(false);
    expect(existsSync(path.join(root, MARKER))).toBe(false);
  }, 120_000);

  it("rollback after our config write never clobbers a later external edit", async () => {
    const root = await legacyRepo();
    await writeFile(path.join(root, "shipgate.config.json"), JSON.stringify({ profile: "node-cli" }) + "\n");
    const userEdit = JSON.stringify({ profile: "node-cli", urgent: "user change" }) + "\n";
    const result = migrateCleanroom({
      root,
      _hooks: {
        afterPlacement: (r) => {
          // User edits the just-placed config AND placed state gets corrupted:
          // rollback must remove our placed state but leave the user's edit.
          writeFileSync(path.join(r, "shipgate.config.json"), userEdit);
          appendFileSync(path.join(r, ".shipgate", "policies", "cleanroom", "waivers.json"), "corrupted");
        },
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("left untouched");
    expect(readFileSync(path.join(root, "shipgate.config.json"), "utf8")).toBe(userEdit);
    expect(existsSync(path.join(root, MIGRATED_STATE))).toBe(false);
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
    expect(result.stderr).toContain("Destination appeared during migration");
    expect(readFileSync(path.join(root, MIGRATED_CONFIG), "utf8")).toBe("OTHER WRITER\n"); // preserved
    expect(existsSync(path.join(root, MARKER))).toBe(false);
    expect(existsSync(path.join(root, LOCK))).toBe(false);
    expect(existsSync(path.join(root, STAGING))).toBe(false);
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
    expect(result.stderr).toContain("Destination appeared during migration");
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
    expect(existsSync(path.join(root, STAGING))).toBe(false);
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
    expect(locked.stderr).toContain("holds the lock");
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

  it("rolls back completely when the staged copy fails re-inventory", async () => {
    const root = await legacyRepo();
    await writeFile(path.join(root, "shipgate.config.json"), JSON.stringify({ profile: "node-cli" }) + "\n");
    const beforeConfig = readFileSync(path.join(root, "shipgate.config.json"));
    const before = treeBytes(root, ".greenroom");
    const result = migrateCleanroom({
      root,
      _hooks: { afterStaging: (stagingAbs) => { appendFileSync(path.join(stagingAbs, ".shipgate", "policies", "cleanroom", "skills", "repo-hygiene", "SKILL.md"), "tampered"); } },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("rolled back");
    expect(result.stderr).toContain("byte hashes or record counts");
    // Legacy untouched; no destination, staging, lock, or marker left behind;
    // pre-existing config restored byte-exact.
    expect(treeBytes(root, ".greenroom")).toEqual(before);
    expect(existsSync(path.join(root, MIGRATED_CONFIG))).toBe(false);
    expect(existsSync(path.join(root, MIGRATED_STATE))).toBe(false);
    expect(existsSync(path.join(root, STAGING))).toBe(false);
    expect(existsSync(path.join(root, LOCK))).toBe(false);
    expect(readFileSync(path.join(root, "shipgate.config.json"))).toEqual(beforeConfig);
  }, 120_000);

  it("rolls back completely when placed state is corrupted before commit", async () => {
    const root = await legacyRepo();
    await writeFile(path.join(root, "shipgate.config.json"), JSON.stringify({ profile: "node-cli", keep: true }) + "\n");
    const beforeConfig = readFileSync(path.join(root, "shipgate.config.json"));
    const before = treeBytes(root, ".greenroom");
    const result = migrateCleanroom({
      root,
      // Corrupt the PLACED migrated state after placement but before the
      // commit marker: the destination verification must catch it and the
      // migration must abort atomically.
      _hooks: { afterPlacement: (r) => { appendFileSync(path.join(r, ".shipgate", "policies", "cleanroom", "waivers.json"), "corrupted"); } },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("rolled back");
    expect(result.stderr).toContain("waivers.json");
    // Atomicity: no destination, staging, lock or marker survives; the legacy
    // source and the pre-existing user config are byte-identical.
    expect(treeBytes(root, ".greenroom")).toEqual(before);
    expect(existsSync(path.join(root, MIGRATED_CONFIG))).toBe(false);
    expect(existsSync(path.join(root, MIGRATED_STATE))).toBe(false);
    expect(existsSync(path.join(root, STAGING))).toBe(false);
    expect(existsSync(path.join(root, LOCK))).toBe(false);
    expect(readFileSync(path.join(root, "shipgate.config.json"))).toEqual(beforeConfig);
  }, 120_000);

  it("after migration the policy dispatcher reads migrated state and check passes", async () => {
    const root = await legacyRepo(false);
    expect(migrateCleanroom({ root }).exitCode).toBe(0);
    const { runCleanroomCli } = await import("../../../src/policies/cleanroom/cli.js");
    const check = runCleanroomCli(["check", "--root", root], { cwd: root });
    expect(check.exitCode).toBe(0);
  }, 120_000);
});
