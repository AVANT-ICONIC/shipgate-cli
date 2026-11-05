// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import packageJson from "../../../package.json";
import { loadConfig } from "../cleanroom/config.mjs";
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

/** Managed files from the legacy config: skill file moves with the state
 * copy; the workflow file must be regenerated against ShipGate commands
 * (Step 8 scope), recorded here so the marker carries the obligation. */
export type ManagedFileEntry = { path: string; action: "move" | "regenerate"; bytes: number; sha256: string };

export function inventoryManagedFiles(root: string): ManagedFileEntry[] {
  const config = loadConfig(root) as { managed?: { skillFile?: string; workflowFile?: string } };
  const entries: ManagedFileEntry[] = [];
  for (const [rel, action] of [
    [config.managed?.skillFile, "move"],
    [config.managed?.workflowFile, "regenerate"],
  ] as const) {
    if (!rel) continue;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const buf = fs.readFileSync(abs);
    entries.push({ path: rel, action, bytes: buf.length, sha256: sha256(buf) });
  }
  return entries;
}

export type MigrateResult = { exitCode: 0 | 2; stdout: string; stderr: string; error?: string };

type Ctx = { root: string; out: string[]; err: string[] };

const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");

function fail(ctx: Ctx, message: string): MigrateResult {
  ctx.err.push(message);
  return { exitCode: 2, stdout: ctx.out.join(""), stderr: ctx.err.join(""), error: message };
}

/** Refuse any symlink inside an inventoried tree: the inventory records
 * regular files only, so copying must not silently preserve or drop links. */
function assertNoSymlinksInTree(root: string, rel: string): void {
  const start = path.join(root, rel);
  if (!fs.existsSync(start)) return;
  if (fs.lstatSync(start).isSymbolicLink()) {
    throw new Error(`Refusing to migrate a symlinked state path: ${rel}. Replace it with a regular file or directory first.`);
  }
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to migrate a symlink inside ${rel}: ${path.relative(root, full)}. Replace it with a regular file or directory first.`);
      }
      if (entry.isDirectory()) walk(full);
    }
  };
  if (fs.statSync(start).isDirectory()) walk(start);
}

/** Refuse to write through any symlinked ancestor under root: a symlinked
 * destination ancestor would redirect mkdir/write/rename outside the repo. */
function assertContainedAncestors(root: string, rel: string): void {
  const parts = rel.split("/").filter((x) => x.length > 0 && x !== ".");
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    cur = path.join(cur, part);
    if (!fs.existsSync(cur)) return; // deeper components will be created as real dirs
    if (fs.lstatSync(cur).isSymbolicLink()) {
      throw new Error(`Refusing to write through symlinked directory: ${path.relative(root, cur)}. Remove the symlink or migrate manually.`);
    }
    if (!fs.statSync(cur).isDirectory()) {
      throw new Error(`Destination ancestor is not a directory: ${path.relative(root, cur)}.`);
    }
  }
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
    // Every structured state file must actually parse; a corrupt payload must
    // never be reported as a successful, verified migration.
    if (rel.endsWith(".json")) readJsonFile(start, rel);
    if (rel.endsWith(".jsonl")) {
      const lines = buf.toString("utf8").split("\n").filter((l) => l.trim().length > 0);
      for (const [i, line] of lines.entries()) {
        try {
          JSON.parse(line);
        } catch {
          throw new Error(`Malformed JSONL in ${rel} line ${i + 1}`);
        }
      }
    }
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
  assertNoSymlinksInTree(root, configRel);
  assertNoSymlinksInTree(root, stateRel);
  const files: InventoryEntry[] = [];
  walkFiles(root, configRel, files);
  walkFiles(root, stateRel, files);
  const counts: InventoryCounts = {
    baselineViolations: countField(root, path.join(stateRel, "baseline.json"), (d) => (d as { violations: unknown[] }).violations.length),
    registryEntries: countField(root, path.join(stateRel, "registry.json"), (d) => {
      const r = d as { responsibilities?: object; components?: object };
      return Object.keys(r.responsibilities ?? {}).length + Object.keys(r.components ?? {}).length;
    }),
    generatedArtifacts: countField(root, path.join(stateRel, "generated.json"), (d) => Object.keys((d as { artifacts?: object }).artifacts ?? {}).length),
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

/** Copy exactly the inventoried legacy files into a full-root staging mirror:
 * staging/shipgate.config.json plus staging/<MIGRATED_CONFIG_FILE> and
 * staging/<MIGRATED_STATE_DIR>/... Only inventoried bytes are staged. */
function copyStateInto(root: string, stagingAbs: string, sourceInventory: Inventory): void {
  fs.mkdirSync(stagingAbs, { recursive: true });
  for (const f of sourceInventory.files) {
    const src = path.join(root, ...f.path.split("/"));
    const rel = f.path === LEGACY_CONFIG_FILE
      ? MIGRATED_CONFIG_FILE
      : `${MIGRATED_STATE_DIR}/${f.path.slice(LEGACY_STATE_DIR.length + 1)}`;
    const dst = path.join(stagingAbs, ...rel.split("/"));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
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

type LegacyCli = { command: string; prefixArgs: string[]; via: string };
type ComparatorInfo = { via: string; resolvedPath: string; version: string; sha256: string | null };

/** Ground the actual comparator: execute --version, hash the script, and
 * require the supported legacy Cleanroom line. Anything else is not a valid
 * parity reference and must not be mislabeled as one in the marker. */
function probeComparator(cli: LegacyCli): ComparatorInfo {
  const probe = spawnSync(cli.command, [...cli.prefixArgs, "--version"], { encoding: "utf8" });
  const out = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
  const match = out.match(/(\d+\.\d+\.\d+)/);
  const matched = match?.[1];
  if (probe.error || probe.status !== 0 || !matched) {
    throw new Error(`The legacy Cleanroom comparator (${cli.via}) did not report a version; cannot ground the parity reference.`);
  }
  const version: string = matched;
  if (!version.startsWith("1.1.")) {
    throw new Error(`The legacy Cleanroom comparator (${cli.via}) reports version ${version}; only the 1.1.x line is a supported parity reference.`);
  }
  const scriptPath = cli.prefixArgs[0] ?? cli.command;
  const hash = fs.existsSync(scriptPath) && fs.statSync(scriptPath).isFile() ? sha256(fs.readFileSync(scriptPath)) : null;
  return { via: cli.via, resolvedPath: scriptPath, version, sha256: hash };
}

/** Resolve a supported legacy Cleanroom CLI for the parity proof: an explicit
 * --legacy-cli path, the bundled @avant-iconic/cleanroom dependency, or a
 * greenroom executable on PATH. Returns null when none is available. */
function resolveLegacyCli(explicit?: string): LegacyCli | null {
  if (explicit) {
    const abs = path.resolve(explicit);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    return { command: process.execPath, prefixArgs: [abs], via: `--legacy-cli (${abs})` };
  }
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve("@avant-iconic/cleanroom/src/cli.mjs");
    return { command: process.execPath, prefixArgs: [resolved], via: "bundled @avant-iconic/cleanroom" };
  } catch {
    // not installed alongside ShipGate: fall through to PATH
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "greenroom");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return { command: candidate, prefixArgs: [], via: `greenroom on PATH (${candidate})` };
    } catch {
      // keep searching
    }
  }
  return null;
}



export type MigrateTestHooks = {
  /** Test seam: runs after staging is complete, before the staged re-inventory. */
  afterStaging?: (stagingAbs: string) => void;
  /** Test seam: runs after staged state is placed, before the parity check. */
  afterPlacement?: (root: string) => void;
  /** Test seam: runs at the start of the placement window, before the first no-replace write. */
  beforePlacement?: (root: string) => void;
};

export function migrateCleanroom(options: { root: string; dryRun?: boolean; json?: boolean; legacyCli?: string; _hooks?: MigrateTestHooks }): MigrateResult {
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
      // Re-run semantics. Only a finalized marker (status "completed" with a
      // parity digest) proves a migration; anything else is an interrupted
      // attempt and must not be reported as success.
      const marker = readJsonFile(markerAbs, MIGRATION_MARKER) as {
        sourceInventory?: Inventory;
        stagedInventory?: Inventory;
        status?: string;
        parityDigest?: string | null;
      };
      if (marker.status !== "completed" || typeof marker.parityDigest !== "string" || marker.parityDigest.length === 0) {
        return fail(ctx, `Found an interrupted migration marker (${MIGRATION_MARKER}, status ${marker.status ?? "unknown"}). A previous migration did not finish; its results are unverified. Inspect ${MIGRATED_STATE_DIR}/, then remove the marker (and any partial destination) or restore from the untouched legacy state before re-running.`);
      }
      if (!migratedPresent) {
        return fail(ctx, `Migration marker ${MIGRATION_MARKER} records a completed migration, but the migrated destination is missing. Restoring is a deliberate act: re-copy from the untouched legacy state or remove the marker.`);
      }
      if (!marker.stagedInventory) {
        return fail(ctx, `Migration marker ${MIGRATION_MARKER} is missing its destination inventory; cannot verify the migrated state. Remove the marker and re-migrate deliberately.`);
      }
      let destCurrent: Inventory;
      try {
        destCurrent = inventoryState(root, MIGRATED_CONFIG_FILE, MIGRATED_STATE_DIR);
      } catch (error) {
        return fail(ctx, `Migrated destination no longer matches the recorded migration (${MIGRATION_MARKER}): ${error instanceof Error ? error.message : String(error)}. Reconcile deliberately.`);
      }
      destCurrent.files = destCurrent.files.filter((f) => f.path !== MIGRATION_MARKER);
      if (!inventoriesEqual(marker.stagedInventory, destCurrent)) {
        return fail(ctx, `Migrated destination no longer matches the recorded migration (${MIGRATION_MARKER}): files were changed, added, or removed after migration. Refusing to guess; reconcile deliberately.`);
      }
      if (!legacyPresent) {
        line("Cleanroom policy state already migrated and verified; no legacy source remains. Nothing to do.");
        return done(0);
      }
      const current = inventoryState(root, LEGACY_CONFIG_FILE, LEGACY_STATE_DIR);
      if (marker.sourceInventory && inventoriesEqual(marker.sourceInventory, current)) {
        line("Cleanroom policy migration already completed and verified for this exact legacy state. No-op.");
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

    const planSummary = () => {
      line(`Cleanroom migration plan for ${root}`);
      line(`  source: ${LEGACY_CONFIG_FILE} + ${LEGACY_STATE_DIR}/ (${sourceInventory.files.length} files, ${sourceInventory.files.reduce((n, f) => n + f.bytes, 0)} bytes)`);
      line(`  destination: ${MIGRATED_CONFIG_FILE} + ${MIGRATED_STATE_DIR}/ (byte-for-byte copy; legacy state is kept)`);
      line(`  config: ${configAction.kind === "json-merge" ? "merge policies.cleanroom into shipgate.config.json" : configAction.kind === "already-present" ? "policies.cleanroom already configured" : "create shipgate.config.json with policies.cleanroom"}`);
    };

    const configAction = planShipGateConfig(root);
    // Containment: never write through a symlinked ancestor, for every path
    // this command creates or overwrites.
    const lockAbs = path.join(root, LOCK_FILE);
    const stagingAbs = path.join(root, STAGING_DIR);
    const placedConfig = path.join(root, MIGRATED_CONFIG_FILE);
    const placedState = path.join(root, MIGRATED_STATE_DIR);
    const shipgateConfigAbs = path.join(root, "shipgate.config.json");
    for (const abs of [lockAbs, stagingAbs, placedConfig, placedState, shipgateConfigAbs, markerAbs, path.join(root, CONFIG_PATCH_FILE)]) {
      assertContainedAncestors(root, path.relative(root, abs));
    }

    if (options.dryRun) {
      planSummary();
      if (configAction.kind === "ts-patch-required") {
        line(`ShipGate config is TypeScript/JavaScript (${path.basename(configAction.file)}): a real run would write a proposed patch to ${CONFIG_PATCH_FILE} and stop.`);
      }
      line("Dry run: no changes were made.");
      return done(0);
    }
    // The legacy CLI is needed for the parity proof; fail before any write if
    // it is not installed (e.g. a production install without devDependencies).
    const legacyCli = resolveLegacyCli(options.legacyCli);
    if (!legacyCli) {
      return fail(ctx, options.legacyCli
        ? `Cannot prove parity: --legacy-cli path does not exist or is not a file (${options.legacyCli}).`
        : "Cannot prove parity: no legacy Cleanroom CLI found. Pass --legacy-cli <path-to-cli.mjs>, install @avant-iconic/cleanroom alongside ShipGate, or put greenroom on PATH.");
    }
    let comparator: ComparatorInfo;
    try {
      comparator = probeComparator(legacyCli);
    } catch (error) {
      return fail(ctx, error instanceof Error ? error.message : String(error));
    }

    // Ownership-tracked rollback: only resources this process created are
    // removed, and only when this process holds the lock. A process that loses
    // the lock race owns nothing and must not touch the winner's files.
    let lockOwned = false;
    let stagingOwned = false;
    let placedConfigOwned = false;
    let placedStateOwned = false;
    let shipgateConfigOwned = false;
    const placedStateFiles: string[] = [];
    const placedStateDirs: string[] = [];
    let originalShipgateConfig: Buffer | null = null; // buffered under the lock
    let writtenShipgateConfig: Buffer | null = null; // exact bytes this process placed
    let shipgateConfigConflict = false;
    const rollback = () => {
      if (!lockOwned) return;
      if (placedStateOwned) {
        // Ownership-safe cleanup: remove only the files and directories this
        // process placed; anything foreign left behind keeps the directory.
        for (const f of placedStateFiles) fs.rmSync(f, { force: true });
        for (const d of [...placedStateDirs].reverse()) {
          try {
            fs.rmdirSync(d);
          } catch {
            // non-empty (foreign content) or already gone: leave it
          }
        }
        try {
          fs.rmdirSync(placedState);
        } catch {
          // foreign content remains: leave the directory in place
        }
      }
      if (placedConfigOwned) fs.rmSync(placedConfig, { force: true });
      if (shipgateConfigOwned) {
        // Conflict-safe restore: only revert bytes this process wrote. If the
        // file changed after our write (external edit), leave it untouched.
        const current = fs.existsSync(shipgateConfigAbs) ? fs.readFileSync(shipgateConfigAbs) : null;
        if (current !== null && writtenShipgateConfig !== null && current.equals(writtenShipgateConfig)) {
          if (originalShipgateConfig) fs.writeFileSync(shipgateConfigAbs, originalShipgateConfig);
          else fs.rmSync(shipgateConfigAbs, { force: true });
        } else {
          shipgateConfigConflict = true;
        }
      }
      if (stagingOwned) fs.rmSync(stagingAbs, { recursive: true, force: true });
      fs.rmSync(lockAbs, { force: true });
    };

    try {
      // 4. Acquire the lock atomically; recover only a lock whose owner died.
      fs.mkdirSync(path.dirname(lockAbs), { recursive: true });
      const lockPayload = () => JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n";
      const tryAcquire = (): boolean => {
        try {
          fs.writeFileSync(lockAbs, lockPayload(), { flag: "wx" });
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          try {
            const held = JSON.parse(fs.readFileSync(lockAbs, "utf8")) as { pid?: number };
            if (typeof held.pid === "number" && held.pid > 0) {
              try {
                process.kill(held.pid, 0); // alive (or EPERM: alive, not ours)
                return false;
              } catch (signalError) {
                if ((signalError as NodeJS.ErrnoException).code === "ESRCH") {
                  fs.rmSync(lockAbs, { force: true }); // stale lock: owner exited
                  return tryAcquire();
                }
                return false;
              }
            }
          } catch (readError) {
            if ((readError as NodeJS.ErrnoException).code !== "ENOENT") {
              // Unreadable/corrupt lock: the holder may still be running.
              return false;
            }
            return tryAcquire(); // vanished between checks: retry once
          }
          return false;
        }
      };
      if (!tryAcquire()) {
        return fail(ctx, `Another migration holds the lock: ${LOCK_FILE}. Refusing to start; no changes were made.`);
      }
      lockOwned = true;

      // 5. Revalidate under the owned lock: the destination and marker were
      // checked before acquisition and could have changed since.
      if (fs.existsSync(markerAbs)) {
        rollback();
        return fail(ctx, `A migration marker appeared at ${MIGRATION_MARKER} while acquiring the lock; another migration finished first. Re-run to verify its result.`);
      }
      if (fs.existsSync(placedConfig) || fs.existsSync(placedState)) {
        rollback();
        return fail(ctx, `Migrated destination appeared while acquiring the lock (${MIGRATED_CONFIG_FILE} / ${MIGRATED_STATE_DIR}/). Refusing to combine two state roots.`);
      }
      if (fs.existsSync(stagingAbs)) fs.rmSync(stagingAbs, { recursive: true, force: true }); // interrupted staging recovery, under lock
      originalShipgateConfig = fs.existsSync(shipgateConfigAbs) ? fs.readFileSync(shipgateConfigAbs) : null;

      // A proposed patch for TypeScript/JavaScript configs is a write too: it
      // happens under containment and the lock, never before them.
      if (configAction.kind === "ts-patch-required") {
        const patchPath = path.join(root, CONFIG_PATCH_FILE);
        fs.mkdirSync(path.dirname(patchPath), { recursive: true });
        fs.writeFileSync(
          patchPath,
          JSON.stringify({ policies: { cleanroom: POLICY_CONFIG_KEY } }, null, 2) + "\n",
        );
        fs.rmSync(lockAbs, { force: true });
        lockOwned = false;
        line(`ShipGate config is TypeScript/JavaScript (${path.basename(configAction.file)}) and cannot be edited safely by heuristics.`);
        line(`A proposed patch was written to ${CONFIG_PATCH_FILE}. Merge policies.cleanroom into the config, then re-run this command.`);
        return done(2);
      }

      // 6. Stage a full-root mirror containing only inventoried bytes.
      copyStateInto(root, stagingAbs, sourceInventory);
      stagingOwned = true;
      if (configAction.kind === "json-merge") {
        const data = readJsonFile(configAction.file, "shipgate.config.json") as Record<string, unknown>;
        const policies = { ...((data.policies as object) ?? {}), cleanroom: POLICY_CONFIG_KEY };
        fs.writeFileSync(path.join(stagingAbs, "shipgate.config.json"), JSON.stringify({ ...data, policies }, null, 2) + "\n");
      } else if (configAction.kind === "none-present-create-json") {
        fs.writeFileSync(path.join(stagingAbs, "shipgate.config.json"), JSON.stringify({ policies: { cleanroom: POLICY_CONFIG_KEY } }, null, 2) + "\n");
      }

      options._hooks?.afterStaging?.(stagingAbs);

      // 7. Re-inventory staging and require every byte hash and count to match.
      const stagedInventory = inventoryState(stagingAbs, MIGRATED_CONFIG_FILE, MIGRATED_STATE_DIR);
      const rebasedSource: Inventory = {
        files: sourceInventory.files.map((f) => ({
          path: f.path === LEGACY_CONFIG_FILE ? MIGRATED_CONFIG_FILE : `${MIGRATED_STATE_DIR}/${f.path.slice(LEGACY_STATE_DIR.length + 1)}`,
          bytes: f.bytes,
          sha256: f.sha256,
        })),
        counts: sourceInventory.counts,
      };
      if (!inventoriesEqual(rebasedSource, stagedInventory)) {
        throw new Error("Staged copy failed verification: byte hashes or record counts do not match the legacy source.");
      }

      // 8. Parity BEFORE placement: legacy check against the real root vs the
      // migrated dispatcher against the staging root. No provisional marker is
      // ever written; a marker only exists once migration is complete.
      const legacy = spawnSync(legacyCli.command, [...legacyCli.prefixArgs, "check", "--json", "--root", root], { encoding: "utf8" });
      // The ported side reads the STAGED state while scanning the REAL
      // repository content: parity compares identical findings, and no marker
      // exists until the migration is committed.
      const stagedStateRoot = path.join(stagingAbs, ".shipgate", "policies");
      const prevStateRoot = process.env.SHIPGATE_CLEANROOM_STATE_ROOT;
      const prevStateRootFor = process.env.SHIPGATE_CLEANROOM_STATE_ROOT_FOR;
      process.env.SHIPGATE_CLEANROOM_STATE_ROOT = stagedStateRoot;
      process.env.SHIPGATE_CLEANROOM_STATE_ROOT_FOR = root;
      let ported: ReturnType<typeof runCleanroomCli>;
      try {
        ported = runCleanroomCli(["check", "--json", "--root", root], { cwd: root });
      } finally {
        if (prevStateRoot === undefined) delete process.env.SHIPGATE_CLEANROOM_STATE_ROOT;
        else process.env.SHIPGATE_CLEANROOM_STATE_ROOT = prevStateRoot;
        if (prevStateRootFor === undefined) delete process.env.SHIPGATE_CLEANROOM_STATE_ROOT_FOR;
        else process.env.SHIPGATE_CLEANROOM_STATE_ROOT_FOR = prevStateRootFor;
      }
      if (legacy.status !== ported.exitCode || canonicalJson(legacy.stdout) !== canonicalJson(ported.stdout)) {
        throw new Error(`Parity mismatch before placement: legacy exit ${String(legacy.status)} vs migrated exit ${ported.exitCode}.`);
      }
      const parityDigest = sha256(Buffer.from(canonicalJson(legacy.stdout)));

      // Managed files are read from the legacy config while only the legacy
      // layout exists (dual-root resolution would refuse later).
      const managedFiles = inventoryManagedFiles(root);

      // 9. Commit check: the legacy source must not have changed since staging;
      // otherwise the verified copy is stale and nothing may be placed.
      if (!inventoriesEqual(sourceInventory, inventoryState(root, LEGACY_CONFIG_FILE, LEGACY_STATE_DIR))) {
        throw new Error("Legacy source changed during the migration; refusing to commit a stale copy. Re-run to migrate the current state.");
      }

      // 10. Place the migration, rechecking each destination under the lock.
      // CAS: if we will write shipgate.config.json, its current content must
      // still be exactly what was staged from; an external edit is a conflict.
      if (configAction.kind === "json-merge" || configAction.kind === "none-present-create-json") {
        const currentConfig = fs.existsSync(shipgateConfigAbs) ? fs.readFileSync(shipgateConfigAbs) : null;
        const stagedFrom = originalShipgateConfig;
        if ((currentConfig === null) !== (stagedFrom === null) || (currentConfig !== null && stagedFrom !== null && !currentConfig.equals(stagedFrom))) {
          throw new Error("shipgate.config.json changed during the migration (external edit). Refusing to overwrite it; re-run to migrate against the current config.");
        }
      }
      options._hooks?.beforePlacement?.(root);

      fs.mkdirSync(path.dirname(placedConfig), { recursive: true });
      // No-replace placement: a plain exists-then-rename window would let a
      // concurrent writer's file be silently overwritten. COPYFILE_EXCL and a
      // non-recursive mkdir fail atomically instead.
      try {
        fs.copyFileSync(path.join(stagingAbs, MIGRATED_CONFIG_FILE), placedConfig, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Destination appeared during migration: ${MIGRATED_CONFIG_FILE}.`);
        throw error;
      }
      placedConfigOwned = true;
      const stagedState = path.join(stagingAbs, MIGRATED_STATE_DIR);
      if (fs.existsSync(stagedState)) {
        try {
          fs.mkdirSync(placedState); // atomic: fails EEXIST if anything already sits there
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Destination appeared during migration: ${MIGRATED_STATE_DIR}/.`);
          throw error;
        }
        placedStateOwned = true;
        const placeTree = (srcDir: string, dstDir: string): void => {
          for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
            const src = path.join(srcDir, entry.name);
            const dst = path.join(dstDir, entry.name);
            if (entry.isDirectory()) {
              try {
                fs.mkdirSync(dst);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                // EEXIST inside our just-created tree means a foreign writer.
                throw new Error(`Destination appeared during migration: ${path.relative(root, dst)}/.`);
              }
              placedStateDirs.push(dst);
              placeTree(src, dst);
            } else {
              try {
                fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Destination appeared during migration: ${path.relative(root, dst)}.`);
                throw error;
              }
              placedStateFiles.push(dst);
            }
          }
        };
        placeTree(stagedState, placedState);
      }
      const stagedConfig = path.join(stagingAbs, "shipgate.config.json");
      if (fs.existsSync(stagedConfig)) {
        // CAS again immediately before the intentional overwrite.
        const currentConfig = fs.existsSync(shipgateConfigAbs) ? fs.readFileSync(shipgateConfigAbs) : null;
        if ((currentConfig === null) !== (originalShipgateConfig === null) || (currentConfig !== null && originalShipgateConfig !== null && !currentConfig.equals(originalShipgateConfig))) {
          throw new Error("shipgate.config.json changed during the migration (external edit). Refusing to overwrite it; re-run to migrate against the current config.");
        }
        writtenShipgateConfig = fs.readFileSync(stagedConfig);
        fs.copyFileSync(stagedConfig, shipgateConfigAbs);
        shipgateConfigOwned = true;
      }

      options._hooks?.afterPlacement?.(root);

      // 11. Verify the placed destination byte-for-byte before committing.
      const placedInventory = inventoryState(root, MIGRATED_CONFIG_FILE, MIGRATED_STATE_DIR);
      if (!inventoriesEqual(stagedInventory, placedInventory)) {
        throw new Error("Placed destination failed verification: bytes differ from the verified staging copy.");
      }

      // 12. Commit: write the finalized marker, then release staging and lock.
      const marker = {
        version: 1,
        managedFiles,
        sourceCommit: spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() || null,
        tools: { shipgate: packageJson.version, cleanroomPolicy: comparator.version, comparator },
        sourceInventory,
        stagedInventory,
        parityDigest,
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      fs.mkdirSync(path.dirname(markerAbs), { recursive: true });
      fs.writeFileSync(markerAbs, JSON.stringify(marker, null, 2) + "\n");
      fs.rmSync(stagingAbs, { recursive: true, force: true });
      stagingOwned = false;
      fs.rmSync(lockAbs, { force: true });
      lockOwned = false;

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
      const conflictNote = shipgateConfigConflict
        ? " Note: shipgate.config.json was changed externally after this migration wrote it; it was left untouched (it may still enable policies.cleanroom)."
        : "";
      return fail(ctx, `Migration failed and was rolled back: ${error instanceof Error ? error.message : String(error)}${conflictNote}`);
    }
  } catch (error) {
    return fail(ctx, error instanceof Error ? error.message : String(error));
  }
}
