import { writeFile, mkdir, symlink } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
    expect(locked.stderr).toContain("active migration lock");
    expect(existsSync(path.join(root2, MIGRATED_CONFIG))).toBe(false);
  }, 120_000);

  it("refuses symlinks escaping the repository", async () => {
    const root = await legacyRepo();
    await symlink("/etc/hostname", path.join(root, ".greenroom", "escape"));
    const result = migrateCleanroom({ root });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Symlink escapes the repository");
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

  it("after migration the policy dispatcher reads migrated state and check passes", async () => {
    const root = await legacyRepo(false);
    expect(migrateCleanroom({ root }).exitCode).toBe(0);
    const { runCleanroomCli } = await import("../../../src/policies/cleanroom/cli.js");
    const check = runCleanroomCli(["check", "--root", root], { cwd: root });
    expect(check.exitCode).toBe(0);
  }, 120_000);
});
