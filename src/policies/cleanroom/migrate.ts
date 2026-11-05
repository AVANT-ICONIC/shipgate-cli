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

/** The lock was lost to another migration between token phase-gates. */
class LockLostError extends Error {
  constructor() {
    super("migration lock lost");
    this.name = "LockLostError";
  }
}
const CONFIG_BACKUP_FILE = ".shipgate/policies/.cleanroom-migrate.config-backup";
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

/** Byte-compare two directory trees (names, structure, file content). */
function treesEqual(a: string, b: string): boolean {
  const entriesOf = (dir: string) => fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name));
  const ea = entriesOf(a);
  const eb = entriesOf(b);
  if (ea.length !== eb.length) return false;
  for (let i = 0; i < ea.length; i += 1) {
    const fa = ea[i]!;
    const fb = fb_of(eb, i);
    if (fa.name !== fb.name || fa.isDirectory() !== fb.isDirectory() || fa.isFile() !== fb.isFile()) return false;
    const pa = path.join(a, fa.name);
    const pb = path.join(b, fb.name);
    if (fa.isDirectory()) {
      if (!treesEqual(pa, pb)) return false;
    } else if (fa.isFile()) {
      if (!fs.readFileSync(pa).equals(fs.readFileSync(pb))) return false;
    } else {
      return false; // sockets/fifos/etc never belong in published state
    }
  }
  return true;
}
function fb_of(eb: fs.Dirent[], i: number): fs.Dirent { return eb[i]!; }

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
  /** Test seam: runs immediately before the shipgate.config.json commit. */
  beforeConfigCommit?: (root: string) => void;
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
    const configBackupAbs = path.join(root, CONFIG_BACKUP_FILE);
    for (const abs of [lockAbs, stagingAbs, placedConfig, placedState, shipgateConfigAbs, markerAbs, configBackupAbs, path.join(root, CONFIG_PATCH_FILE)]) {
      assertContainedAncestors(root, path.relative(root, abs));
    }

    if (options.dryRun) {
      if (migratedPresent) {
        return fail(ctx, `Ambiguous destination: migrated state already exists (${MIGRATED_CONFIG_FILE} / ${MIGRATED_STATE_DIR}/) without a migration marker. Refusing to combine two state roots.`);
      }
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
    let placedStateRenamed = false; // only a renamed-in tree is ours to remove recursively
    let shipgateConfigOwned = false;
    let shipgateConfigWriteComplete = false;
    let configBackupOwned = false;
    let releaseLock: () => void = () => undefined; // bound after acquisition
    let originalShipgateConfig: Buffer | null = null; // buffered under the lock
    let writtenShipgateConfig: Buffer | null = null; // exact bytes this process placed
    let shipgateConfigConflict = false;
    const rollback = () => {
      if (!lockOwned) return;
      // Only a tree actually renamed in from verified staging is ours to
      // remove wholesale. If the rename never happened (foreign content
      // blocked it), the directory holds foreign bytes: remove it only when
      // empty, leaving anything foreign untouched.
      if (placedStateRenamed) fs.rmSync(placedState, { recursive: true, force: true });
      else if (placedStateOwned) {
        try {
          fs.rmdirSync(placedState);
        } catch {
          // foreign content present: preserved
        }
      }
      if (placedConfigOwned) fs.rmSync(placedConfig, { force: true });
      if (shipgateConfigOwned) {
        // Conflict-safe restore: remove the file when it is exactly what this
        // process wrote - or, after an interrupted write, a strict PREFIX of
        // it (a partial copy is unambiguously ours). Anything else is a later
        // external edit and is preserved.
        const current = fs.existsSync(shipgateConfigAbs) ? fs.readFileSync(shipgateConfigAbs) : null;
        const isOurs = current !== null && writtenShipgateConfig !== null
          && (current.equals(writtenShipgateConfig)
            || (!shipgateConfigWriteComplete && current.length < writtenShipgateConfig.length && writtenShipgateConfig.subarray(0, current.length).equals(current)));
        if (isOurs) {
          fs.rmSync(shipgateConfigAbs, { force: true });
          if (configBackupOwned) fs.renameSync(configBackupAbs, shipgateConfigAbs);
          configBackupOwned = false;
        } else {
          shipgateConfigConflict = true; // leave the user's newer edit in place
        }
      } else if (configBackupOwned) {
        // Failed between move-aside and fill: restore the original, unless a
        // foreign file took the path (preserved, reported as a conflict).
        if (!fs.existsSync(shipgateConfigAbs)) {
          fs.renameSync(configBackupAbs, shipgateConfigAbs);
        } else {
          shipgateConfigConflict = true;
        }
        configBackupOwned = false;
      }
      if (stagingOwned) fs.rmSync(stagingAbs, { recursive: true, force: true });
      releaseLock();
      lockOwned = false;
    };

    try {
      // 4. Acquire the lock atomically; recover only a lock whose owner died.
      // Stale reclamation is identity-verified: the lock's raw bytes are
      // captured, the file is moved aside atomically, and only reclaimed when
      // the moved-aside content still matches what was validated stale. A
      // replacement lock from a new live owner is moved straight back.
      fs.mkdirSync(path.dirname(lockAbs), { recursive: true });
      const ourToken = crypto.randomUUID();
      const lockPayload = () => JSON.stringify({ pid: process.pid, token: ourToken, startedAt: new Date().toISOString() }) + "\n";
      let reclaimAttempt = 0;
      const tryAcquire = (): boolean => {
        try {
          fs.writeFileSync(lockAbs, lockPayload(), { flag: "wx" });
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          let raw: string;
          try {
            raw = fs.readFileSync(lockAbs, "utf8");
          } catch (readError) {
            if ((readError as NodeJS.ErrnoException).code === "ENOENT") return reclaimAttempt++ < 4 ? tryAcquire() : false;
            return false; // unreadable: the holder may still be running
          }
          let held: { pid?: number };
          try {
            held = JSON.parse(raw) as { pid?: number };
          } catch {
            return false; // corrupt lock: cannot establish staleness safely
          }
          if (typeof held.pid !== "number" || held.pid <= 0) return false;
          try {
            process.kill(held.pid, 0); // alive (or EPERM: alive, not ours)
            return false;
          } catch (signalError) {
            if ((signalError as NodeJS.ErrnoException).code !== "ESRCH") return false;
          }
          // Owner is dead. Reclaim by atomic move-aside with identity check.
          // FAIL CLOSED on any doubt: a mismatched (someone else's) lock is
          // never moved back over a possibly newer lock; it stays as a
          // tombstone and this run refuses. The disturbed owner detects the
          // loss at its next token phase-gate and freezes without writes.
          const tombstone = `${lockAbs}.reclaim-${process.pid}-${reclaimAttempt}`;
          try {
            fs.renameSync(lockAbs, tombstone);
          } catch (renameError) {
            if ((renameError as NodeJS.ErrnoException).code === "ENOENT") return reclaimAttempt++ < 4 ? tryAcquire() : false;
            throw renameError;
          }
          let movedRaw: string;
          try {
            movedRaw = fs.readFileSync(tombstone, "utf8");
          } catch {
            movedRaw = "";
          }
          if (movedRaw !== raw) {
            return false; // tombstone left in place as evidence; never restored over a newer lock
          }
          fs.rmSync(tombstone, { force: true }); // verified-stale lock reclaimed
          return reclaimAttempt++ < 4 ? tryAcquire() : false;
        }
      };
      if (!tryAcquire()) {
        return fail(ctx, `Another migration holds the lock: ${LOCK_FILE}. Refusing to start; no changes were made.`);
      }
      lockOwned = true;
      releaseLock = () => {
        // Remove only our own lock, verified by token.
        try {
          const raw = fs.readFileSync(lockAbs, "utf8");
          const parsed = JSON.parse(raw) as { token?: string };
          if (parsed.token === ourToken) fs.rmSync(lockAbs, { force: true });
        } catch {
          // already gone or unreadable: leave it
        }
      };

      // Token phase-gate: before every mutation phase, prove we still hold
      // the lock. On loss we freeze: no writes, no deletions - the next run
      // recovers staging/partials under a firmly held lock.
      const assertLockHeld = () => {
        let raw: string | null = null;
        try {
          raw = fs.readFileSync(lockAbs, "utf8");
        } catch {
          raw = null;
        }
        if (raw === null) throw new LockLostError();
        try {
          if ((JSON.parse(raw) as { token?: string }).token !== ourToken) throw new LockLostError();
        } catch (error) {
          if (error instanceof LockLostError) throw error;
          throw new LockLostError();
        }
      };

      // 5. Revalidate under the owned lock: the destination and marker were
      // checked before acquisition and could have changed since.
      if (fs.existsSync(markerAbs)) {
        rollback();
        return fail(ctx, `A migration marker appeared at ${MIGRATION_MARKER} while acquiring the lock; another migration finished first. Re-run to verify its result.`);
      }
      // A destination without a marker is either a crash remnant with its
      // verified staging still present (resumable: publish is idempotent and
      // every piece is byte-verified against staging) or foreign state.
      let resuming = false;
      if (fs.existsSync(placedConfig) || fs.existsSync(placedState)) {
        if (!fs.existsSync(stagingAbs)) {
          rollback();
          return fail(ctx, `Ambiguous destination: migrated state exists (${MIGRATED_CONFIG_FILE} / ${MIGRATED_STATE_DIR}/) without a migration marker or staging to verify it against. Refusing to combine two state roots.`);
        }
        resuming = true;
      }
      if (fs.existsSync(stagingAbs) && !resuming) fs.rmSync(stagingAbs, { recursive: true, force: true }); // interrupted staging recovery, under lock
      for (const entry of fs.readdirSync(path.dirname(lockAbs))) {
        if (entry.startsWith(".cleanroom-migrate.lock.reclaim-")) {
          fs.rmSync(path.join(path.dirname(lockAbs), entry), { force: true }); // tombstone evidence from prior contention, cleared under a held lock
        }
      }
      if (fs.existsSync(configBackupAbs)) {
        if (!fs.existsSync(shipgateConfigAbs)) {
          fs.renameSync(configBackupAbs, shipgateConfigAbs); // crashed between move-aside and fill
        } else {
          return fail(ctx, `A previous migration left a config backup at ${CONFIG_BACKUP_FILE} while shipgate.config.json exists. Reconcile the two deliberately, then re-run.`);
        }
      }
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
        releaseLock();
        lockOwned = false;
        line(`ShipGate config is TypeScript/JavaScript (${path.basename(configAction.file)}) and cannot be edited safely by heuristics.`);
        line(`A proposed patch was written to ${CONFIG_PATCH_FILE}. Merge policies.cleanroom into the config, then re-run this command.`);
        return done(2);
      }

      assertLockHeld();

      // 6. Stage a full-root mirror containing only inventoried bytes.
      if (!resuming) {
        copyStateInto(root, stagingAbs, sourceInventory);
      }
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

      // Managed files are read from the verified staged config under the same
      // state-root override (a resumed migration can already have a published
      // destination, and dual-root resolution would refuse here).
      const prevStateRoot2 = process.env.SHIPGATE_CLEANROOM_STATE_ROOT;
      const prevStateRootFor2 = process.env.SHIPGATE_CLEANROOM_STATE_ROOT_FOR;
      process.env.SHIPGATE_CLEANROOM_STATE_ROOT = stagedStateRoot;
      process.env.SHIPGATE_CLEANROOM_STATE_ROOT_FOR = root;
      let managedFiles: ManagedFileEntry[];
      try {
        managedFiles = inventoryManagedFiles(root);
      } finally {
        if (prevStateRoot2 === undefined) delete process.env.SHIPGATE_CLEANROOM_STATE_ROOT;
        else process.env.SHIPGATE_CLEANROOM_STATE_ROOT = prevStateRoot2;
        if (prevStateRootFor2 === undefined) delete process.env.SHIPGATE_CLEANROOM_STATE_ROOT_FOR;
        else process.env.SHIPGATE_CLEANROOM_STATE_ROOT_FOR = prevStateRootFor2;
      }

      // 9. Commit check: the legacy source must not have changed since staging;
      // otherwise the verified copy is stale and nothing may be placed.
      if (!inventoriesEqual(sourceInventory, inventoryState(root, LEGACY_CONFIG_FILE, LEGACY_STATE_DIR))) {
        throw new Error("Legacy source changed during the migration; refusing to commit a stale copy. Re-run to migrate the current state.");
      }

      assertLockHeld();

      // 10. Publish the migration. Genuine boundary: POSIX has no multi-file
      // atomic commit, so publication is built from single-syscall atomic
      // pieces - a directory rename for the whole state tree, a hardlink for
      // each file - and any crash between them is recovered by re-running:
      // publish is idempotent and every already-placed piece is byte-verified
      // against the verified staging mirror. The one true overwrite, an
      // existing shipgate.config.json, uses the move-aside backup protocol.
      options._hooks?.beforePlacement?.(root);
      fs.mkdirSync(path.dirname(placedConfig), { recursive: true });

      // Migrated config file: materialize in a temp file, then hardlink into
      // place - an atomic no-replace commit that never exposes partial content.
      const stagedConfigFile = path.join(stagingAbs, MIGRATED_CONFIG_FILE);
      if (fs.existsSync(placedConfig)) {
        if (!fs.readFileSync(placedConfig).equals(fs.readFileSync(stagedConfigFile))) {
          throw new Error(`Destination ${MIGRATED_CONFIG_FILE} differs from the verified staged copy. Refusing to overwrite foreign content.`);
        }
        placedConfigOwned = true; // our own earlier publication, byte-verified
      } else {
        const configTemp = `${placedConfig}.tmp-${process.pid}`;
        try {
          fs.copyFileSync(stagedConfigFile, configTemp, fs.constants.COPYFILE_EXCL);
          fs.linkSync(configTemp, placedConfig);
          placedConfigOwned = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Destination appeared during migration: ${MIGRATED_CONFIG_FILE}.`);
          placedConfigOwned = fs.existsSync(placedConfig); // defensive: failed link leaves nothing
          throw error;
        } finally {
          fs.rmSync(configTemp, { force: true });
        }
      }

      // State tree: one atomic directory rename. We first mkdir the
      // destination (fails EEXIST on anything foreign); the rename then
      // replaces only our own empty directory and fails ENOTEMPTY if foreign
      // content lands inside it, so publication is all-or-nothing.
      const stagedState = path.join(stagingAbs, MIGRATED_STATE_DIR);
      if (fs.existsSync(stagedState)) {
        if (fs.existsSync(placedState)) {
          if (fs.readdirSync(placedState).length === 0 && fs.lstatSync(placedState).isDirectory()) {
            fs.rmdirSync(placedState); // our own crash remnant: publish fresh below
          } else if (treesEqual(stagedState, placedState)) {
            placedStateOwned = true;
            placedStateRenamed = true; // byte-verified as exactly the staged tree
          } else {
            throw new Error(`Destination ${MIGRATED_STATE_DIR}/ differs from the verified staged copy. Refusing to overwrite foreign content.`);
          }
        }
        if (!placedStateOwned) {
          try {
            fs.mkdirSync(placedState);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Destination appeared during migration: ${MIGRATED_STATE_DIR}/.`);
            throw error;
          }
          placedStateOwned = true;
          try {
            fs.renameSync(stagedState, placedState);
            placedStateRenamed = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY" || (error as NodeJS.ErrnoException).code === "EEXIST") {
              throw new Error(`Foreign content appeared inside ${MIGRATED_STATE_DIR}/ during publication; refusing to continue.`);
            }
            throw error;
          }
        }
      }

      const stagedConfig = path.join(stagingAbs, "shipgate.config.json");
      if (fs.existsSync(stagedConfig)) {
        assertLockHeld();
        options._hooks?.beforeConfigCommit?.(root);
        writtenShipgateConfig = fs.readFileSync(stagedConfig);
        const currentConfig = fs.existsSync(shipgateConfigAbs) ? fs.readFileSync(shipgateConfigAbs) : null;
        if (currentConfig !== null && currentConfig.equals(writtenShipgateConfig)) {
          // A previous crashed run already committed these exact bytes.
          shipgateConfigOwned = true;
        } else if (configAction.kind === "none-present-create-json") {
          // New file: EXCL create — a foreign config appearing at the last
          // instant is a conflict, never an overwrite.
          try {
            fs.copyFileSync(stagedConfig, shipgateConfigAbs, fs.constants.COPYFILE_EXCL);
            shipgateConfigOwned = true;
            shipgateConfigWriteComplete = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              throw new Error("shipgate.config.json appeared during the migration (external write). Refusing to overwrite it; re-run to migrate against the current config.");
            }
            shipgateConfigOwned = fs.existsSync(shipgateConfigAbs); // partial copy: removed by prefix check in rollback
            throw error;
          }
        } else {
          // Merge: move the original aside atomically, verify the moved-aside
          // bytes are exactly what was staged from (an edit racing the compare
          // travels with the move and is caught), then EXCL-fill the path.
          if (currentConfig === null || originalShipgateConfig === null || !currentConfig.equals(originalShipgateConfig)) {
            throw new Error("shipgate.config.json changed during the migration (external edit). Refusing to overwrite it; re-run to migrate against the current config.");
          }
          fs.renameSync(shipgateConfigAbs, configBackupAbs);
          configBackupOwned = true;
          const movedAside = fs.readFileSync(configBackupAbs);
          if (!movedAside.equals(originalShipgateConfig)) {
            fs.renameSync(configBackupAbs, shipgateConfigAbs); // put the foreign edit back
            configBackupOwned = false;
            throw new Error("shipgate.config.json changed during the migration (external edit). Refusing to overwrite it; re-run to migrate against the current config.");
          }
          try {
            fs.copyFileSync(stagedConfig, shipgateConfigAbs, fs.constants.COPYFILE_EXCL);
            shipgateConfigOwned = true;
            shipgateConfigWriteComplete = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              // A foreign file took the path while the original was aside:
              // leave the foreign file exactly where it is, keep the original
              // config at a unique backup path, and report the conflict.
              const backupKeep = `${shipgateConfigAbs}.migration-backup-${Date.now()}-${process.pid}`;
              fs.renameSync(configBackupAbs, backupKeep);
              configBackupOwned = false;
              throw new Error(`shipgate.config.json appeared during the migration (external write). The foreign file was left untouched at shipgate.config.json; the original config was kept at ${path.basename(backupKeep)}. Reconcile deliberately, then re-run.`);
            }
            shipgateConfigOwned = fs.existsSync(shipgateConfigAbs); // partial copy: removed by prefix check in rollback
            throw error;
          }
        }
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
      assertLockHeld();
      fs.mkdirSync(path.dirname(markerAbs), { recursive: true });
      const markerTemp = `${markerAbs}.tmp-${process.pid}`;
      fs.writeFileSync(markerTemp, JSON.stringify(marker, null, 2) + "\n");
      try {
        fs.linkSync(markerTemp, markerAbs); // atomic no-replace commit point
      } finally {
        fs.rmSync(markerTemp, { force: true });
      }
      fs.rmSync(stagingAbs, { recursive: true, force: true });
      stagingOwned = false;
      if (configBackupOwned) {
        fs.rmSync(configBackupAbs, { force: true });
        configBackupOwned = false;
      }
      releaseLock();
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
      if (error instanceof LockLostError) {
        // Freeze: another migration owns the lock now; it owns cleanup/resume.
        return fail(ctx, "Migration lock lost to another migration; froze without further writes or cleanup. Re-run to resume safely.");
      }
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
