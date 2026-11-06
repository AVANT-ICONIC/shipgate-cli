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
import {
  JOURNAL_PREFIX,
  createJournal,
  fsyncDir,
  fsyncFile,
  hasAnyPublicationStep,
  journalFileName,
  lastStepFor,
  listJournals,
  readJournal,
  recordStep,
  type Journal,
} from "./migrate-journal.js";

/**
 * Spec issue #1 step 6: lossless migration of Cleanroom legacy state
 * (`.greenroom.json` + `.greenroom/*`) into the ShipGate layout
 * (`.shipgate/policies/cleanroom.json` + `.shipgate/policies/cleanroom/*`).
 *
 * Section 2.2: this module returns exit codes and output; the command
 * boundary (src/commands/migrate.ts) assigns `process.exitCode`. Nothing
 * here writes to the console or terminates the process.
 *
 * Reviewed publication protocol (fail-closed, journaled, monotonic):
 * - Legacy state is never deleted. An existing JSON shipgate.config.json is
 *   never merged automatically (no in-place merge of a pre-existing file can
 *   be made safe against foreign-byte loss): it gets a proposed merged config
 *   and exit 2, like the TypeScript/JavaScript case.
 * - Every public path is created by an exclusive operation (O_EXCL copy,
 *   mkdir, hardlink); nothing foreign is ever overwritten or deleted, and
 *   content equality is never treated as ownership.
 * - Every public mutation is recorded in a durable per-run journal (fsync of
 *   file and parent directory) before it is attempted and after it lands.
 * - A handled failure BEFORE any publication removes only private per-run
 *   resources (staging, temps, journal) and releases the lock (spec 6.10).
 * - A handled failure AFTER any publication preserves the published bytes and
 *   the journal, removes staging/temps, and releases the lock; the error
 *   names what was retained. Published bytes are never unpublished.
 * - A process crash leaves everything as it was; the next run fails closed
 *   on the stale lock with a diagnosis, and after the operator deliberately
 *   removes the lock it resumes by re-staging a fresh snapshot and
 *   byte-verifying every journaled piece.
 * - A completed identical migration re-run is a no-op; changed legacy source
 *   after a completed migration is a conflict.
 */

const LOCK_FILE = ".shipgate/policies/.cleanroom-migrate.lock";
const LEGACY_STAGING_DIR = ".shipgate/policies/.cleanroom-migrate.staging"; // pre-journal naming; migrator scratch only
const STAGING_PREFIX = ".cleanroom-migrate.staging-";
const CONFIG_BACKUP_FILE = ".shipgate/policies/.cleanroom-migrate.config-backup";
const CONFIG_PATCH_FILE = ".shipgate/policies/cleanroom.config-patch.json";
const POLICIES_DIR = ".shipgate/policies";
const POLICY_CONFIG_KEY = { enabled: true, configFile: ".shipgate/policies/cleanroom.json" } as const;

/** Test-only crash seam: SHIPGATE_CLEANROOM_MIGRATE_CRASH_AT names a
 * boundary at which the process SIGKILLs itself, so tests exercise genuine
 * process death at every publication boundary instead of simulated hooks. */
const CRASH_ENV = "SHIPGATE_CLEANROOM_MIGRATE_CRASH_AT";

/** The lock was lost to another migration between token phase-gates. */
class LockLostError extends Error {
  constructor() {
    super("migration lock lost");
    this.name = "LockLostError";
  }
}

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
    for (const entry of fs.readdirSync(start).sort((a, b) => a.localeCompare(b))) {
      walkFiles(root, path.join(rel, entry), into);
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
    const fb = eb[i]!;
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
      // Code configs cannot be edited safely by heuristics: require the human
      // to apply a proposed patch instead.
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

/** A private per-run resource, identity-tracked at creation: cleanup removes
 * it only when the path still holds the exact inode this run created, so an
 * EEXIST collision or a foreign replacement is never deleted. */
type PrivateResource = { abs: string; dev: number; ino: number; recursive: boolean };

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
  const crashAt = process.env[CRASH_ENV] ?? null;
  const crashPoint = (name: string): void => {
    if (crashAt === name) process.kill(process.pid, "SIGKILL");
  };

  try {
    // 1. Validate exactly one complete legacy source.
    const legacyConfigAbs = path.join(root, LEGACY_CONFIG_FILE);
    const legacyStateAbs = path.join(root, LEGACY_STATE_DIR);
    const markerAbs = path.join(root, MIGRATION_MARKER);
    const policiesDirAbs = path.join(root, POLICIES_DIR);
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
      // The migration is complete. Leftover migrator scratch (journals,
      // staging dirs, a stale lock) from a crash after the commit point is
      // REPORTED, never deleted here: a name prefix alone does not prove
      // migrator ownership, and the lock may belong to a live holder.
      const residue = fs.readdirSync(policiesDirAbs).filter(
        (entry) =>
          entry.startsWith(JOURNAL_PREFIX) ||
          entry.startsWith(STAGING_PREFIX) ||
          entry === path.basename(LEGACY_STAGING_DIR) ||
          entry === path.basename(LOCK_FILE),
      );
      if (residue.length > 0) {
        line(`Note: interrupted-migration residue present (${residue.join(", ")}). It is preserved because ownership cannot be proven from names alone; inspect and remove it deliberately when convenient.`);
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
    const sourceDigest = sha256(Buffer.from(JSON.stringify(sourceInventory)));
    // Config must parse as a legacy Cleanroom config object.
    readJsonFile(legacyConfigAbs, LEGACY_CONFIG_FILE);

    const configAction = planShipGateConfig(root);
    const planSummary = () => {
      line(`Cleanroom migration plan for ${root}`);
      line(`  source: ${LEGACY_CONFIG_FILE} + ${LEGACY_STATE_DIR}/ (${sourceInventory.files.length} files, ${sourceInventory.files.reduce((n, f) => n + f.bytes, 0)} bytes)`);
      line(`  destination: ${MIGRATED_CONFIG_FILE} + ${MIGRATED_STATE_DIR}/ (byte-for-byte copy; legacy state is kept)`);
      line(`  config: ${configAction.kind === "json-merge" ? "write a proposed merged shipgate.config.json (automatic in-place merge disabled)" : configAction.kind === "already-present" ? "policies.cleanroom already configured" : "create shipgate.config.json with policies.cleanroom"}`);
    };

    // Containment: never write through a symlinked ancestor, for every path
    // this command creates or overwrites.
    const lockAbs = path.join(root, LOCK_FILE);
    const placedConfig = path.join(root, MIGRATED_CONFIG_FILE);
    const placedState = path.join(root, MIGRATED_STATE_DIR);
    const shipgateConfigAbs = path.join(root, "shipgate.config.json");
    const configBackupAbs = path.join(root, CONFIG_BACKUP_FILE);
    const runId = crypto.randomUUID();
    const stagingAbs = path.join(policiesDirAbs, `${STAGING_PREFIX}${runId}`);
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

    // Private per-run resources, identity-tracked: only the exact inodes this
    // run created are ever removed. Anything else is preserved and reported.
    const privateResources: PrivateResource[] = [];
    const preservedPrivate: string[] = [];
    const trackPrivate = (abs: string, recursive: boolean): void => {
      const st = fs.lstatSync(abs);
      privateResources.push({ abs, dev: st.dev, ino: st.ino, recursive });
    };
    const removePrivate = (res: PrivateResource): void => {
      privateResources.splice(privateResources.indexOf(res), 1);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(res.abs);
      } catch {
        return; // already gone
      }
      if (st.dev !== res.dev || st.ino !== res.ino) {
        preservedPrivate.push(res.abs); // foreign replacement: never deleted
        return;
      }
      fs.rmSync(res.abs, { recursive: res.recursive, force: true });
    };

    // Journal writes rewrite the file via temp+rename, so the tracked
    // identity must follow the current inode after every recorded step.
    let journalAbs: string | null = null;
    const journaled = (journal: Journal, step: Parameters<typeof recordStep>[2]): void => {
      recordStep(policiesDirAbs, journal, step);
      if (journalAbs !== null) {
        const res = privateResources.find((r) => r.abs === journalAbs);
        if (res) {
          const st = fs.lstatSync(journalAbs);
          res.dev = st.dev;
          res.ino = st.ino;
        }
      }
    };

    // 2. Acquire the lock with a single exclusive create. Fail closed on any
    // existing lock: no automatic reclaim, no tombstones. The refusal carries
    // a full diagnosis; recovery is a deliberate operator act.
    fs.mkdirSync(policiesDirAbs, { recursive: true });
    const ourToken = crypto.randomUUID();
    const lockPayload = () => JSON.stringify({ pid: process.pid, token: ourToken, startedAt: new Date().toISOString(), runId }) + "\n";
    try {
      fs.writeFileSync(lockAbs, lockPayload(), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let diagnosis = "unreadable lock file";
      try {
        const raw = fs.readFileSync(lockAbs, "utf8");
        const held = JSON.parse(raw) as { pid?: number; startedAt?: string };
        let liveness = "unknown";
        if (typeof held.pid === "number" && held.pid > 0) {
          try {
            process.kill(held.pid, 0);
            liveness = "process currently ALIVE";
          } catch (signalError) {
            liveness = (signalError as NodeJS.ErrnoException).code === "ESRCH" ? "process no longer running" : "process status not checkable";
          }
        }
        diagnosis = `recorded pid ${String(held.pid)}, started ${held.startedAt ?? "unknown"}, ${liveness}`;
      } catch {
        // keep the generic diagnosis
      }
      const journals = listJournals(policiesDirAbs);
      if (journals.length === 1) {
        try {
          const interrupted = readJournal(path.join(policiesDirAbs, journals[0]!));
          const last = interrupted.steps[interrupted.steps.length - 1];
          diagnosis += `; journal ${journals[0]} last step: ${last ? `${last.op} ${last.status}` : "none"}`;
        } catch {
          diagnosis += `; journal ${journals[0]} unreadable`;
        }
      }
      return fail(ctx, `A migration lock is present: ${LOCK_FILE} (${diagnosis}). Refusing to start; no changes were made. ` +
        `The lock serializes cooperative migrators; it is never reclaimed automatically. ` +
        `After confirming no migration is running, remove the lock file deliberately and re-run: the run resumes from the durable journal, byte-verifying anything already published.`);
    }
    let lockOwned = true;
    const releaseLock = () => {
      if (!lockOwned) return;
      // Remove only our own lock, verified by token.
      try {
        const raw = fs.readFileSync(lockAbs, "utf8");
        const parsed = JSON.parse(raw) as { token?: string };
        if (parsed.token === ourToken) {
          fs.rmSync(lockAbs, { force: true });
          fsyncDir(policiesDirAbs);
        }
      } catch {
        // already gone or unreadable: leave it
      }
      lockOwned = false;
    };
    crashPoint("afterLock");

    // Token phase-gate: before every mutation phase, prove we still hold the
    // lock. On loss we freeze: no writes, no deletions. The token disciplines
    // cooperative migrators only; it is not fencing against arbitrary editors.
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

    try {
      // 3. Revalidate under the owned lock: the destination and marker were
      // checked before acquisition and could have changed since.
      if (fs.existsSync(markerAbs)) {
        releaseLock();
        return fail(ctx, `A migration marker appeared at ${MIGRATION_MARKER} while acquiring the lock; another migration finished first. Re-run to verify its result.`);
      }

      // 4. Adopt exactly one durable journal, or create this run's. The
      // journal is the audit and recovery record of every public mutation.
      const journalNames = listJournals(policiesDirAbs);
      let journal: Journal;
      if (journalNames.length > 1) {
        releaseLock();
        return fail(ctx, `Multiple migration journals found (${journalNames.join(", ")}): ambiguous recovery state. Reconcile deliberately (inspect the journals and published state), then re-run.`);
      }
      if (journalNames.length === 1) {
        try {
          journal = readJournal(path.join(policiesDirAbs, journalNames[0]!));
        } catch (error) {
          releaseLock();
          return fail(ctx, `${error instanceof Error ? error.message : String(error)}. Reconcile deliberately, then re-run.`);
        }
        if (journal.sourceDigest !== sourceDigest) {
          releaseLock();
          return fail(ctx, `Legacy Cleanroom source changed since the interrupted migration recorded in ${journalNames[0]}. Refusing to resume against a different source; published pieces and the journal are preserved. Reconcile deliberately, then re-run.`);
        }
        journalAbs = path.join(policiesDirAbs, journalNames[0]!);
        trackPrivate(journalAbs, false);
        journaled(journal, { op: "resume-adopt", status: "done", detail: { pid: process.pid, runId } });
      } else {
        journal = createJournal(policiesDirAbs, runId, sourceDigest);
        journalAbs = path.join(policiesDirAbs, journalFileName(runId));
        trackPrivate(journalAbs, false);
      }
      crashPoint("afterJournalCreate");

      // A destination without a marker is explained only by journaled
      // publication steps (begin OR done - a crash between the link and the
      // done record still explains the bytes). Anything else is foreign state.
      if ((fs.existsSync(placedConfig) || fs.existsSync(placedState)) && !hasAnyPublicationStep(journal)) {
        throw new Error(`Ambiguous destination: migrated state exists (${MIGRATED_CONFIG_FILE} / ${MIGRATED_STATE_DIR}/) without a migration marker or a journal recording its publication. Refusing to combine two state roots.`);
      }

      // Clean migrator scratch: the pre-journal fixed-name staging dir is
      // migrator-private by definition; per-run staging dirs are removed only
      // when the adopted journal records them with a matching identity.
      for (const entry of fs.readdirSync(policiesDirAbs)) {
        const abs = path.join(policiesDirAbs, entry);
        if (entry === path.basename(LEGACY_STAGING_DIR)) {
          fs.rmSync(abs, { recursive: true, force: true });
          continue;
        }
        if (!entry.startsWith(STAGING_PREFIX)) continue;
        const recorded = journal.steps.find(
          (s) => s.op === "staging" && s.status === "done" && (s.detail as { staging?: string } | undefined)?.staging === entry,
        );
        if (!recorded) {
          preservedPrivate.push(abs); // unknown provenance: preserved, reported
          continue;
        }
        const detail = recorded.detail as { dev?: number; ino?: number } | undefined;
        let st: fs.Stats | null = null;
        try {
          st = fs.lstatSync(abs);
        } catch {
          st = null;
        }
        if (st && detail && st.dev === detail.dev && st.ino === detail.ino) {
          fs.rmSync(abs, { recursive: true, force: true });
        } else if (st) {
          preservedPrivate.push(abs); // identity mismatch: preserved, reported
        }
      }

      // Config backup residue from an earlier merge-protocol attempt is
      // preserved, never auto-restored: its ownership cannot be re-proven.
      if (fs.existsSync(configBackupAbs)) {
        throw new Error(`A config backup from an earlier migration attempt exists at ${CONFIG_BACKUP_FILE}. It was preserved; inspect it, restore or remove it deliberately, then re-run.`);
      }

      // A proposed patch is a write too: it happens under containment and
      // the lock, never before them. Two cases stop here with exit 2:
      // TypeScript/JavaScript configs (cannot be edited safely by
      // heuristics) and existing JSON configs (no in-place merge of a
      // pre-existing file can be made safe against foreign-byte loss, so the
      // automatic merge of spec 6.6 is disabled pending the owner decision).
      if (configAction.kind === "ts-patch-required" || configAction.kind === "json-merge") {
        const patchContent =
          configAction.kind === "json-merge"
            ? (() => {
                const data = readJsonFile(configAction.file, "shipgate.config.json") as Record<string, unknown>;
                const policies = { ...((data.policies as object) ?? {}), cleanroom: POLICY_CONFIG_KEY };
                return JSON.stringify({ ...data, policies }, null, 2) + "\n";
              })()
            : JSON.stringify({ policies: { cleanroom: POLICY_CONFIG_KEY } }, null, 2) + "\n";
        let patchPath = path.join(root, CONFIG_PATCH_FILE);
        try {
          fs.writeFileSync(patchPath, patchContent, { flag: "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!fs.readFileSync(patchPath).equals(Buffer.from(patchContent))) {
            // A foreign or edited patch occupies the path: keep it, write ours
            // at a unique path instead of overwriting.
            patchPath = path.join(policiesDirAbs, `cleanroom.config-patch-${runId}.json`);
            fs.writeFileSync(patchPath, patchContent, { flag: "wx" });
          }
        }
        journaled(journal, { op: "config", status: "done", detail: { kind: configAction.kind, patch: path.relative(root, patchPath) } });
        // No publication happened: remove the journal and release the lock.
        for (const res of [...privateResources]) removePrivate(res);
        releaseLock();
        if (configAction.kind === "ts-patch-required") {
          line(`ShipGate config is TypeScript/JavaScript (${path.basename(configAction.file)}) and cannot be edited safely by heuristics.`);
          line(`A proposed patch was written to ${path.relative(root, patchPath)}. Merge policies.cleanroom into the config, then re-run this command.`);
        } else {
          line(`ShipGate config already exists as JSON (shipgate.config.json). Automatic in-place merge is disabled: replacing a pre-existing file can destroy foreign bytes.`);
          line(`A proposed merged config was written to ${path.relative(root, patchPath)}. Review it, replace shipgate.config.json with it, then re-run this command.`);
        }
        return done(2);
      }

      assertLockHeld();

      // 5. Stage a FRESH full-root snapshot from the validated source, even
      // when resuming: staged bytes are re-derived, never trusted from a
      // previous run.
      journaled(journal, { op: "staging", status: "begin" });
      fs.mkdirSync(stagingAbs); // exclusive: a fresh uuid cannot collide
      trackPrivate(stagingAbs, true);
      const stagingStat = fs.lstatSync(stagingAbs);
      journaled(journal, {
        op: "staging",
        status: "done",
        detail: { staging: path.basename(stagingAbs), dev: stagingStat.dev, ino: stagingStat.ino },
      });
      crashPoint("afterStagingCreated");

      journaled(journal, { op: "snapshot", status: "begin" });
      copyStateInto(root, stagingAbs, sourceInventory);
      if (configAction.kind === "none-present-create-json") {
        fs.writeFileSync(path.join(stagingAbs, "shipgate.config.json"), JSON.stringify({ policies: { cleanroom: POLICY_CONFIG_KEY } }, null, 2) + "\n");
      }
      journaled(journal, { op: "config", status: "done", detail: { kind: configAction.kind } });

      options._hooks?.afterStaging?.(stagingAbs);

      // 6. Re-inventory staging and require every byte hash and count to match.
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
      journaled(journal, { op: "snapshot", status: "done", detail: { files: stagedInventory.files.length, bytes: stagedInventory.files.reduce((n, f) => n + f.bytes, 0) } });
      crashPoint("afterSnapshot");

      // 7. Parity BEFORE placement: legacy check against the real root vs the
      // migrated dispatcher against the staging root. No provisional marker is
      // ever written; a marker only exists once migration is complete.
      journaled(journal, { op: "parity", status: "begin" });
      const legacy = spawnSync(legacyCli.command, [...legacyCli.prefixArgs, "check", "--json", "--root", root], { encoding: "utf8" });
      // The ported side reads the STAGED state while scanning the REAL
      // repository content: parity compares identical findings, and no marker
      // exists until the migration is committed.
      const stagedStateRoot = path.join(stagingAbs, ".shipgate", "policies");
      const withStateRootOverride = <T>(fn: () => T): T => {
        const prevStateRoot = process.env.SHIPGATE_CLEANROOM_STATE_ROOT;
        const prevStateRootFor = process.env.SHIPGATE_CLEANROOM_STATE_ROOT_FOR;
        process.env.SHIPGATE_CLEANROOM_STATE_ROOT = stagedStateRoot;
        process.env.SHIPGATE_CLEANROOM_STATE_ROOT_FOR = root;
        try {
          return fn();
        } finally {
          if (prevStateRoot === undefined) delete process.env.SHIPGATE_CLEANROOM_STATE_ROOT;
          else process.env.SHIPGATE_CLEANROOM_STATE_ROOT = prevStateRoot;
          if (prevStateRootFor === undefined) delete process.env.SHIPGATE_CLEANROOM_STATE_ROOT_FOR;
          else process.env.SHIPGATE_CLEANROOM_STATE_ROOT_FOR = prevStateRootFor;
        }
      };
      const ported = withStateRootOverride(() => runCleanroomCli(["check", "--json", "--root", root], { cwd: root }));
      if (legacy.status !== ported.exitCode || canonicalJson(legacy.stdout) !== canonicalJson(ported.stdout)) {
        throw new Error(`Parity mismatch before placement: legacy exit ${String(legacy.status)} vs migrated exit ${ported.exitCode}.`);
      }
      const parityDigest = sha256(Buffer.from(canonicalJson(legacy.stdout)));
      journaled(journal, { op: "parity", status: "done", detail: { parityDigest, comparator } });
      crashPoint("afterParity");

      // Managed files are read from the verified staged config under the same
      // state-root override (a resumed migration can already have a published
      // destination, and dual-root resolution would refuse here).
      const managedFiles = withStateRootOverride(() => inventoryManagedFiles(root));

      // 8. Commit check: the legacy source must not have changed since staging;
      // otherwise the verified copy is stale and nothing may be placed.
      if (!inventoriesEqual(sourceInventory, inventoryState(root, LEGACY_CONFIG_FILE, LEGACY_STATE_DIR))) {
        throw new Error("Legacy source changed during the migration; refusing to commit a stale copy. Re-run to migrate the current state.");
      }

      assertLockHeld();

      // 9. Publish. Genuine boundary: POSIX has no multi-file atomic commit,
      // so publication is a monotonic sequence of single-syscall exclusive
      // creates, each journaled before and after. A crash between them is
      // recovered by re-running: every already-placed piece is byte-verified
      // against the fresh staging snapshot and adopted, never overwritten.
      // Published pieces are NEVER removed on failure.
      journaled(journal, { op: "publish-config", status: "begin" });
      options._hooks?.beforePlacement?.(root);
      crashPoint("beforePublishConfig");
      fs.mkdirSync(path.dirname(placedConfig), { recursive: true });

      // Migrated config file: materialize in a temp file, then hardlink into
      // place - an atomic no-replace commit that never exposes partial content.
      const stagedConfigFile = path.join(stagingAbs, MIGRATED_CONFIG_FILE);
      if (fs.existsSync(placedConfig)) {
        if (!fs.readFileSync(placedConfig).equals(fs.readFileSync(stagedConfigFile))) {
          throw new Error(`Destination ${MIGRATED_CONFIG_FILE} differs from the verified staged copy. Refusing to overwrite foreign content.`);
        }
      } else {
        const configTemp = `${placedConfig}.tmp-${runId}`;
        try {
          fs.copyFileSync(stagedConfigFile, configTemp, fs.constants.COPYFILE_EXCL);
          trackPrivate(configTemp, false);
          fs.linkSync(configTemp, placedConfig);
          crashPoint("afterConfigLink"); // linked but not yet journaled done
          fsyncFile(placedConfig);
          fsyncDir(path.dirname(placedConfig));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            // Someone else placed the path (or the temp) during publication.
            throw new Error(`Destination appeared during migration: ${MIGRATED_CONFIG_FILE}.`);
          }
          throw error;
        } finally {
          const tempRes = privateResources.find((r) => r.abs === configTemp);
          if (tempRes) removePrivate(tempRes); // only our own EXCL-created temp is removed
        }
      }
      journaled(journal, { op: "publish-config", status: "done", path: MIGRATED_CONFIG_FILE, sha256: sha256(fs.readFileSync(placedConfig)) });
      crashPoint("afterPublishConfig");

      // State tree: one atomic directory rename onto our own reservation. We
      // first mkdir the destination (fails EEXIST on anything foreign); the
      // rename then replaces only our own empty directory and fails ENOTEMPTY
      // if foreign content lands inside it, which is preserved, never removed.
      const stagedState = path.join(stagingAbs, MIGRATED_STATE_DIR);
      journaled(journal, { op: "publish-state", status: "begin" });
      if (fs.existsSync(stagedState)) {
        let adoptedState = false;
        if (fs.existsSync(placedState)) {
          const placedStat = fs.lstatSync(placedState);
          if (!placedStat.isDirectory()) {
            throw new Error(`Destination ${MIGRATED_STATE_DIR} exists and is not a directory. Refusing to overwrite foreign content.`);
          }
          if (fs.readdirSync(placedState).length === 0) {
            // An empty directory holds no bytes, but a journaled reservation
            // BEGIN proves only intent, not ownership: a crash between the
            // begin record and the mkdir leaves the slot open to a foreign
            // creator. Only a recorded DONE with a matching identity (dev/ino)
            // proves the directory is our reservation. Anything else is
            // preserved; removal is a deliberate operator act.
            const reservation = lastStepFor(journal, "state-reservation");
            const identity = reservation?.detail as { dev?: number; ino?: number } | undefined;
            const provenReservation =
              reservation?.status === "done" && identity?.dev === placedStat.dev && identity?.ino === placedStat.ino;
            if (!provenReservation) {
              throw new Error(`Destination ${MIGRATED_STATE_DIR}/ is an empty directory without a journaled, identity-matching reservation. It may be foreign and is preserved; remove it deliberately and re-run.`);
            }
            fs.rmdirSync(placedState);
          } else if (treesEqual(stagedState, placedState)) {
            adoptedState = true; // byte-verified as exactly the staged tree
          } else {
            throw new Error(`Destination ${MIGRATED_STATE_DIR}/ differs from the verified staged copy. Refusing to overwrite foreign content.`);
          }
        }
        if (!adoptedState) {
          journaled(journal, { op: "state-reservation", status: "begin" });
          crashPoint("afterReservationBegin"); // intent recorded, nothing created
          try {
            fs.mkdirSync(placedState);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Destination appeared during migration: ${MIGRATED_STATE_DIR}/.`);
            throw error;
          }
          const reservationStat = fs.lstatSync(placedState);
          journaled(journal, { op: "state-reservation", status: "done", detail: { dev: reservationStat.dev, ino: reservationStat.ino } });
          crashPoint("afterStateReservation");
          try {
            fs.renameSync(stagedState, placedState);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY" || (error as NodeJS.ErrnoException).code === "EEXIST") {
              throw new Error(`Foreign content appeared inside ${MIGRATED_STATE_DIR}/ during publication; it was preserved, not removed. Reconcile deliberately, then re-run.`);
            }
            throw error;
          }
          fsyncDir(path.dirname(placedState));
        }
      }
      journaled(journal, { op: "publish-state", status: "done", path: MIGRATED_STATE_DIR });
      crashPoint("afterPublishState");

      const stagedConfig = path.join(stagingAbs, "shipgate.config.json");
      if (fs.existsSync(stagedConfig)) {
        assertLockHeld();
        journaled(journal, { op: "config-commit", status: "begin" });
        options._hooks?.beforeConfigCommit?.(root);
        crashPoint("beforeConfigCommit");
        const writtenShipgateConfig = fs.readFileSync(stagedConfig);
        const currentConfig = fs.existsSync(shipgateConfigAbs) ? fs.readFileSync(shipgateConfigAbs) : null;
        if (currentConfig !== null && currentConfig.equals(writtenShipgateConfig)) {
          // A previous crashed run already committed these exact bytes.
        } else {
          // Create-only: EXCL create. Any existing different content - foreign
          // or user-authored - is a conflict, never an overwrite. (Existing
          // JSON configs never reach this point: they stop at the proposed
          // patch above. The rejected move-aside merge machinery is gone.)
          try {
            fs.copyFileSync(stagedConfig, shipgateConfigAbs, fs.constants.COPYFILE_EXCL);
            fsyncFile(shipgateConfigAbs);
            fsyncDir(root);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              throw new Error("shipgate.config.json appeared during the migration (external write). Refusing to overwrite it; re-run to migrate against the current config.");
            }
            throw new Error(`Failed to write shipgate.config.json; any partial file was left in place deliberately. Reconcile and re-run. (${error instanceof Error ? error.message : String(error)})`);
          }
        }
        journaled(journal, { op: "config-commit", status: "done", path: "shipgate.config.json" });
        crashPoint("afterConfigCommit");
      }

      options._hooks?.afterPlacement?.(root);

      // 10. Verify the placed destination byte-for-byte before committing.
      const placedInventory = inventoryState(root, MIGRATED_CONFIG_FILE, MIGRATED_STATE_DIR);
      if (!inventoriesEqual(stagedInventory, placedInventory)) {
        throw new Error("Placed destination failed verification: bytes differ from the verified staging copy. Published pieces are preserved and journaled; re-run to resume after reconciling.");
      }

      // 11. Commit point: write the finalized marker via temp + hardlink
      // (atomic, no-replace), fsynced, then release private resources.
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
      journaled(journal, { op: "marker-commit", status: "begin" });
      crashPoint("beforeMarkerCommit");
      fs.mkdirSync(path.dirname(markerAbs), { recursive: true });
      const markerTemp = `${markerAbs}.tmp-${runId}`;
      fs.writeFileSync(markerTemp, JSON.stringify(marker, null, 2) + "\n", { flag: "wx" });
      trackPrivate(markerTemp, false);
      fsyncFile(markerTemp);
      try {
        fs.linkSync(markerTemp, markerAbs); // atomic no-replace commit point
        fsyncFile(markerAbs);
        fsyncDir(path.dirname(markerAbs));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`A marker appeared at ${MIGRATION_MARKER} during the commit; refusing to replace it. Published pieces are preserved and journaled; re-run to verify.`);
        }
        throw error;
      } finally {
        const tempRes = privateResources.find((r) => r.abs === markerTemp);
        if (tempRes) removePrivate(tempRes);
      }
      journaled(journal, { op: "marker-commit", status: "done", path: MIGRATION_MARKER });
      crashPoint("afterMarkerCommit");

      // Success: remove private per-run resources (staging, journal, temps),
      // identity-verified. Published bytes stay.
      for (const res of [...privateResources]) removePrivate(res);
      releaseLock();

      if (preservedPrivate.length > 0) {
        line(`Note: preserved foreign paths that collided with private scratch: ${preservedPrivate.map((p) => path.relative(root, p)).join(", ")}`);
      }
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
      // Failure classification reconciles evidence, not just completed ops:
      // a journaled BEGIN (the mutation may have landed), an unreadable
      // journal, or an actual public path all mean "publication may have
      // begun" - preserve and journal, never clean as if nothing happened.
      const journalRes = privateResources.find((r) => path.basename(r.abs).startsWith(JOURNAL_PREFIX));
      let published = false;
      if (journalRes !== undefined) {
        try {
          published = hasAnyPublicationStep(readJournal(journalRes.abs));
        } catch {
          published = true; // unreadable journal after mutations: preserve, never risk cleanup
        }
      }
      if (!published && (fs.existsSync(placedConfig) || fs.existsSync(placedState) || fs.existsSync(markerAbs))) {
        published = true; // public bytes exist; they need a journal, not deletion
      }
      if (published) {
        // After a public mutation: preserve published bytes and the journal,
        // remove only staging/temps, release the lock.
        for (const res of [...privateResources]) {
          if (res === journalRes) continue;
          removePrivate(res);
        }
        releaseLock();
        const preservedNote = preservedPrivate.length > 0 ? ` Foreign paths preserved: ${preservedPrivate.map((p) => path.relative(root, p)).join(", ")}.` : "";
        return fail(ctx, `Migration interrupted after partial publication: ${error instanceof Error ? error.message : String(error)}. ` +
          `Published bytes were preserved and journaled (${path.basename(journalRes!.abs)}); nothing was rolled back.${preservedNote} ` +
          `Re-run this command to resume: every journaled piece is byte-verified against a fresh snapshot.`);
      }
      // Before any public mutation (spec 6.10): remove staging, temps, journal
      // and release the lock. Nothing public exists to preserve.
      for (const res of [...privateResources]) removePrivate(res);
      releaseLock();
      const preservedNote = preservedPrivate.length > 0 ? ` Foreign paths preserved: ${preservedPrivate.map((p) => path.relative(root, p)).join(", ")}.` : "";
      return fail(ctx, `Migration failed before any publication; staging and lock were removed: ${error instanceof Error ? error.message : String(error)}${preservedNote}`);
    }
  } catch (error) {
    return fail(ctx, error instanceof Error ? error.message : String(error));
  }
}
