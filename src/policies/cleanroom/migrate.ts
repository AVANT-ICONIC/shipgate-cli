// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import packageJson from "../../../package.json";
import {
  LEGACY_CONFIG_FILE,
  LEGACY_STATE_DIR,
  MIGRATED_CONFIG_FILE,
  MIGRATED_STATE_DIR,
  MIGRATION_MARKER,
} from "./paths.js";
import { runCleanroomCli } from "./cli.js";

/**
 * Spec issue #1 step 6: lossless migration of Cleanroom legacy state
 * (`.greenroom.json` + `.greenroom/*`) into the ShipGate layout
 * (`.shipgate/policies/cleanroom.json` + `.shipgate/policies/cleanroom/*`).
 *
 * Section 2.2: this module returns exit codes and output; the command
 * boundary (src/commands/migrate.ts) assigns `process.exitCode`. Nothing
 * here writes to the console or terminates the process.
 *
 * Guarantees: legacy state is never deleted; any failure removes staging,
 * lock and any half-placed destination, then returns 2; a completed
 * identical migration re-run is a no-op; changed legacy source after a
 * completed migration is a conflict.
 */

const LOCK_FILE = ".shipgate/policies/.cleanroom-migrate.lock";
const STAGING_DIR = ".shipgate/policies/.cleanroom-migrate.staging";
const CONFIG_PATCH_FILE = ".shipgate/policies/cleanroom.config-patch.json";
const POLICY_CONFIG_KEY = { enabled: true, configFile: ".shipgate/policies/cleanroom.json" } as const;

export type InventoryEntry = { path: string; bytes: number; sha256: string };
export type InventoryCounts = {
  baselineViolations: number | null;
  registryEntries: number | null;
  generatedArtifacts: number | null;
  waivers: number | null;
  governanceLines: number | null;
};
export type Inventory = { files: InventoryEntry[]; counts: InventoryCounts };

export type MigrateResult = { exitCode: 0 | 2; stdout: string; stderr: string; error?: string };

type Ctx = { root: string; out: string[]; err: string[] };

const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");

function fail(ctx: Ctx, message: string): MigrateResult {
  ctx.err.push(message);
  return { exitCode: 2, stdout: ctx.out.join(""), stderr: ctx.err.join(""), error: message };
}

/** Refuse any symlink under root/rel whose target escapes the repo root. */
function assertNoEscapingSymlinks(root: string, rel: string): void {
  const start = path.join(root, rel);
  if (!fs.existsSync(start)) return;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(full);
        if (!target.startsWith(root + path.sep) && target !== root) {
          throw new Error(`Symlink escapes the repository: ${path.relative(root, full)} -> ${target}`);
        }
      } else if (entry.isDirectory()) walk(full);
    }
  };
  const stat = fs.lstatSync(start);
  if (stat.isSymbolicLink()) {
    const target = fs.realpathSync(start);
    if (!target.startsWith(root + path.sep)) throw new Error(`Symlink escapes the repository: ${rel} -> ${target}`);
    return;
  }
  if (stat.isDirectory()) walk(start);
}

function readJsonFile(file: string, label: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Malformed JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}

function countField(root: string, rel: string, count: (data: unknown) => number): number | null {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) return null;
  return count(readJsonFile(file, rel));
}

function walkFiles(root: string, rel: string, into: InventoryEntry[]): void {
  const start = path.join(root, rel);
  if (!fs.existsSync(start)) return;
  const stat = fs.lstatSync(start);
  if (stat.isFile()) {
    const buf = fs.readFileSync(start);
    into.push({ path: rel.split(path.sep).join("/"), bytes: buf.length, sha256: sha256(buf) });
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(start, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      walkFiles(root, path.join(rel, entry.name), into);
    }
  }
}

/** Inventory every byte of the legacy (or staged) policy state, with record counts. */
export function inventoryState(root: string, configRel: string, stateRel: string): Inventory {
  assertNoEscapingSymlinks(root, configRel);
  assertNoEscapingSymlinks(root, stateRel);
  const files: InventoryEntry[] = [];
  walkFiles(root, configRel, files);
  walkFiles(root, stateRel, files);
  const counts: InventoryCounts = {
    baselineViolations: countField(root, path.join(stateRel, "baseline.json"), (d) => (d as { violations: unknown[] }).violations.length),
    registryEntries: countField(root, path.join(stateRel, "registry.json"), (d) => Object.keys(d as object).length),
    generatedArtifacts: countField(root, path.join(stateRel, "generated.json"), (d) => Object.keys(d as object).length),
    waivers: countField(root, path.join(stateRel, "waivers.json"), (d) => ((d as { waivers?: unknown[] }).waivers ?? []).length),
    governanceLines: (() => {
      const file = path.join(root, stateRel, "governance.jsonl");
      if (!fs.existsSync(file)) return null;
      const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
      for (const [i, line] of lines.entries()) {
        try {
          JSON.parse(line);
        } catch {
          throw new Error(`Malformed JSONL in ${path.join(stateRel, "governance.jsonl")} line ${i + 1}`);
        }
      }
      return lines.length;
    })(),
  };
  return { files, counts };
}

function inventoriesEqual(a: Inventory, b: Inventory): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function copyStateInto(root: string, stagingAbs: string): void {
  fs.mkdirSync(stagingAbs, { recursive: true });
  fs.copyFileSync(path.join(root, LEGACY_CONFIG_FILE), path.join(stagingAbs, "cleanroom.json"));
  const stateSrc = path.join(root, LEGACY_STATE_DIR);
  if (fs.existsSync(stateSrc)) {
    fs.cpSync(stateSrc, path.join(stagingAbs, "cleanroom"), { recursive: true, verbatimSymlinks: true });
  }
}

type ShipGateConfigAction =
  | { kind: "none-present-create-json" }
  | { kind: "json-merge"; file: string }
  | { kind: "already-present" }
  | { kind: "ts-patch-required"; file: string };

function planShipGateConfig(root: string): ShipGateConfigAction {
  const jsonFile = path.join(root, "shipgate.config.json");
  if (fs.existsSync(jsonFile)) {
    const data = readJsonFile(jsonFile, "shipgate.config.json") as Record<string, unknown>;
    const policies = data.policies as Record<string, unknown> | undefined;
    if (policies && "cleanroom" in policies) return { kind: "already-present" };
    return { kind: "json-merge", file: jsonFile };
  }
  for (const name of ["shipgate.config.ts", "shipgate.config.mts", "shipgate.config.js", "shipgate.config.mjs", "shipgate.config.cjs"]) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) {
      // Code configs cannot be edited safely by heuristics: check whether the
      // policy is already wired by loading is out of scope here; require the
      // human to apply a proposed patch instead.
      return { kind: "ts-patch-required", file };
    }
  }
  return { kind: "none-present-create-json" };
}

const ISO_OUT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z/g;
function canonicalJson(text: string): string {
  const parsed: unknown = JSON.parse(text);
  return JSON.stringify(parsed, (key, value: unknown) => (typeof value === "string" ? value.replace(ISO_OUT, "<TS>") : value));
}

function legacyCliPath(): string {
  const require = createRequire(import.meta.url);
  return require.resolve("@avant-iconic/cleanroom/src/cli.mjs");
}



export function migrateCleanroom(options: { root: string; dryRun?: boolean; json?: boolean }): MigrateResult {
  const root = path.resolve(options.root);
  const ctx: Ctx = { root, out: [], err: [] };
  const line = (text: string) => ctx.out.push(`${text}\n`);
  const done = (exitCode: 0 | 2): MigrateResult => ({ exitCode, stdout: ctx.out.join(""), stderr: ctx.err.join("") });

  try {
    // 1. Validate exactly one complete legacy source.
    const legacyConfigAbs = path.join(root, LEGACY_CONFIG_FILE);
    const legacyStateAbs = path.join(root, LEGACY_STATE_DIR);
    const markerAbs = path.join(root, MIGRATION_MARKER);
    const legacyPresent = fs.existsSync(legacyConfigAbs) || fs.existsSync(legacyStateAbs);
    const migratedPresent = fs.existsSync(path.join(root, MIGRATED_CONFIG_FILE)) || fs.existsSync(path.join(root, MIGRATED_STATE_DIR));

    if (fs.existsSync(markerAbs)) {
      // Re-run semantics: identical completed migration is a no-op; changed
      // legacy source after migration is a conflict.
      if (!legacyPresent) {
        line("Cleanroom policy state already migrated; no legacy source remains. Nothing to do.");
        return done(0);
      }
      const marker = readJsonFile(markerAbs, MIGRATION_MARKER) as { sourceInventory?: Inventory };
      const current = inventoryState(root, LEGACY_CONFIG_FILE, LEGACY_STATE_DIR);
      if (marker.sourceInventory && inventoriesEqual(marker.sourceInventory, current)) {
        line("Cleanroom policy migration already completed for this exact legacy state. No-op.");
        return done(0);
      }
      return fail(ctx, "Legacy Cleanroom state changed after the completed migration. This is a conflict: keep the migrated state or re-migrate deliberately after removing " + MIGRATION_MARKER + ".");
    }
    if (!legacyPresent) return fail(ctx, `No legacy Cleanroom state found (${LEGACY_CONFIG_FILE} / ${LEGACY_STATE_DIR}/).`);
    if (!fs.existsSync(legacyConfigAbs) || !fs.existsSync(legacyStateAbs)) {
      return fail(ctx, `Incomplete legacy Cleanroom source: need both ${LEGACY_CONFIG_FILE} and ${LEGACY_STATE_DIR}/.`);
    }
    if (migratedPresent) {
      return fail(ctx, `Ambiguous destination: migrated state already exists (${MIGRATED_CONFIG_FILE} / ${MIGRATED_STATE_DIR}/) without a migration marker. Refusing to combine two state roots.`);
    }
    // Malformed JSON/JSONL and symlink escapes fail here.
    const sourceInventory = inventoryState(root, LEGACY_CONFIG_FILE, LEGACY_STATE_DIR);
    // Config must parse as a legacy Cleanroom config object.
    readJsonFile(legacyConfigAbs, LEGACY_CONFIG_FILE);

    const configAction = planShipGateConfig(root);
    if (configAction.kind === "ts-patch-required") {
      const patchPath = path.join(root, CONFIG_PATCH_FILE);
      fs.mkdirSync(path.dirname(patchPath), { recursive: true });
      fs.writeFileSync(
        patchPath,
        JSON.stringify({ policies: { cleanroom: POLICY_CONFIG_KEY } }, null, 2) + "\n",
      );
      line(`ShipGate config is TypeScript/JavaScript (${path.basename(configAction.file)}) and cannot be edited safely by heuristics.`);
      line(`A proposed patch was written to ${CONFIG_PATCH_FILE}. Merge policies.cleanroom into the config, then re-run this command.`);
      return done(2);
    }

    const planSummary = () => {
      line(`Cleanroom migration plan for ${root}`);
      line(`  source: ${LEGACY_CONFIG_FILE} + ${LEGACY_STATE_DIR}/ (${sourceInventory.files.length} files, ${sourceInventory.files.reduce((n, f) => n + f.bytes, 0)} bytes)`);
      line(`  destination: ${MIGRATED_CONFIG_FILE} + ${MIGRATED_STATE_DIR}/ (byte-for-byte copy; legacy state is kept)`);
      line(`  config: ${configAction.kind === "json-merge" ? "merge policies.cleanroom into shipgate.config.json" : configAction.kind === "already-present" ? "policies.cleanroom already configured" : "create shipgate.config.json with policies.cleanroom"}`);
    };

    if (options.dryRun) {
      planSummary();
      line("Dry run: no changes were made.");
      return done(0);
    }

    // 2. Refuse an active migration lock; clean only stale staging.
    const lockAbs = path.join(root, LOCK_FILE);
    const stagingAbs = path.join(root, STAGING_DIR);
    if (fs.existsSync(lockAbs)) return fail(ctx, `An active migration lock exists: ${LOCK_FILE}. Refusing to start another migration.`);
    if (fs.existsSync(stagingAbs)) fs.rmSync(stagingAbs, { recursive: true, force: true }); // interrupted staging recovery

    const placedConfig = path.join(root, MIGRATED_CONFIG_FILE);
    const placedState = path.join(root, MIGRATED_STATE_DIR);
    const shipgateConfigAbs = path.join(root, "shipgate.config.json");
    const originalShipgateConfig = fs.existsSync(shipgateConfigAbs) ? fs.readFileSync(shipgateConfigAbs) : null;
    const rollback = () => {
      fs.rmSync(stagingAbs, { recursive: true, force: true });
      fs.rmSync(placedConfig, { force: true });
      fs.rmSync(placedState, { recursive: true, force: true });
      fs.rmSync(lockAbs, { force: true });
      if (originalShipgateConfig) fs.writeFileSync(shipgateConfigAbs, originalShipgateConfig);
      else fs.rmSync(shipgateConfigAbs, { force: true });
    };

    try {
      // 3. Acquire the lock atomically.
      fs.mkdirSync(path.dirname(lockAbs), { recursive: true });
      fs.writeFileSync(lockAbs, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n", { flag: "wx" });

      // 4/5. Stage a byte-for-byte copy.
      copyStateInto(root, stagingAbs);
      if (configAction.kind === "json-merge") {
        const data = readJsonFile(configAction.file, "shipgate.config.json") as Record<string, unknown>;
        const policies = { ...((data.policies as object) ?? {}), cleanroom: POLICY_CONFIG_KEY };
        fs.writeFileSync(path.join(stagingAbs, "shipgate.config.json"), JSON.stringify({ ...data, policies }, null, 2) + "\n");
      } else if (configAction.kind === "none-present-create-json") {
        fs.writeFileSync(path.join(stagingAbs, "shipgate.config.json"), JSON.stringify({ policies: { cleanroom: POLICY_CONFIG_KEY } }, null, 2) + "\n");
      }

      // 6. Re-inventory staging and require every byte hash and count to match.
      const stagedInventory = inventoryState(stagingAbs, "cleanroom.json", "cleanroom");
      const rebasedSource: Inventory = {
        files: sourceInventory.files.map((f) => ({
          path: f.path === LEGACY_CONFIG_FILE ? "cleanroom.json" : f.path.replace(/^\.greenroom\//, "cleanroom/"),
          bytes: f.bytes,
          sha256: f.sha256,
        })),
        counts: sourceInventory.counts,
      };
      if (!inventoriesEqual(rebasedSource, stagedInventory)) {
        throw new Error("Staged copy failed verification: byte hashes or record counts do not match the legacy source.");
      }

      // 7. Place the migration atomically (per item), then prove parity with a
      // provisional marker so the migrated state resolves, then finalize.
      fs.mkdirSync(path.dirname(placedConfig), { recursive: true });
      fs.renameSync(path.join(stagingAbs, "cleanroom.json"), placedConfig);
      if (fs.existsSync(path.join(stagingAbs, "cleanroom"))) fs.renameSync(path.join(stagingAbs, "cleanroom"), placedState);
      const stagedConfig = path.join(stagingAbs, "shipgate.config.json");
      if (fs.existsSync(stagedConfig)) fs.renameSync(stagedConfig, shipgateConfigAbs);
      fs.rmSync(stagingAbs, { recursive: true, force: true });

      const markerBase = {
        version: 1,
        sourceCommit: spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() || null,
        tools: { shipgate: packageJson.version, cleanroomPolicy: "1.1.0" },
        sourceInventory,
        stagedInventory,
        parityDigest: null as string | null,
        status: "verifying" as string,
        startedAt: new Date().toISOString(),
        completedAt: null as string | null,
      };
      fs.mkdirSync(path.dirname(path.join(root, MIGRATION_MARKER)), { recursive: true });
      fs.writeFileSync(path.join(root, MIGRATION_MARKER), JSON.stringify(markerBase, null, 2) + "\n");

      // 8. Parity: legacy check --json vs migrated dispatcher check --json.
      const legacy = spawnSync(process.execPath, [legacyCliPath(), "check", "--json", "--root", root], { encoding: "utf8" });
      const ported = runCleanroomCli(["check", "--json", "--root", root], { cwd: root });
      if (legacy.status !== ported.exitCode || canonicalJson(legacy.stdout) !== canonicalJson(ported.stdout)) {
        throw new Error(`Parity mismatch after migration: legacy exit ${String(legacy.status)} vs migrated exit ${ported.exitCode}.`);
      }
      const parityDigest = sha256(Buffer.from(canonicalJson(legacy.stdout)));

      // 9. Finalize the marker.
      fs.writeFileSync(
        path.join(root, MIGRATION_MARKER),
        JSON.stringify({ ...markerBase, parityDigest, status: "completed", completedAt: new Date().toISOString() }, null, 2) + "\n",
      );
      fs.rmSync(lockAbs, { force: true });

      if (options.json) {
        line(JSON.stringify({ migrated: true, files: sourceInventory.files.length, bytes: sourceInventory.files.reduce((n, f) => n + f.bytes, 0), parityDigest }, null, 2));
      } else {
        planSummary();
        line(`Parity verified: legacy and migrated check --json match (digest ${parityDigest.slice(0, 12)}).`);
        line("Migration complete. Legacy state was left untouched; remove it deliberately when ready.");
      }
      return done(0);
    } catch (error) {
      rollback();
      return fail(ctx, `Migration failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    return fail(ctx, error instanceof Error ? error.message : String(error));
  }
}
