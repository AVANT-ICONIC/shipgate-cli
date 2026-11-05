// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import path from "node:path";

/**
 * Dual-mode state resolution for the Cleanroom policy pack (spec Step 3).
 *
 * Legacy mode keeps Cleanroom's layout byte-for-byte: `.greenroom.json` plus
 * `.greenroom/*`. Migrated mode reads the config from
 * `.shipgate/policies/cleanroom.json` and state from
 * `.shipgate/policies/cleanroom/*`. Config values stay LOGICAL (for example
 * `baselineFile: ".greenroom/baseline.json"`) so a copied config keeps its
 * policy hash; rebasing to the migrated root happens here, at I/O time only.
 *
 * A read never silently combines two state roots: if both layouts exist and
 * no migration marker chooses one, resolution throws StateConflictError,
 * which carries exitCode 2 (invalid) for the command boundary.
 */

export const LEGACY_CONFIG_FILE = ".greenroom.json";
export const LEGACY_STATE_DIR = ".greenroom";
export const MIGRATED_CONFIG_FILE = ".shipgate/policies/cleanroom.json";
export const MIGRATED_STATE_DIR = ".shipgate/policies/cleanroom";
export const MIGRATION_MARKER = ".shipgate/policies/cleanroom/migration.json";

export type StateMode = "legacy" | "migrated";

export class StateConflictError extends Error {
  readonly exitCode = 2;
  constructor(root: string) {
    super(
      `Both legacy Green Room state (${LEGACY_CONFIG_FILE} / ${LEGACY_STATE_DIR}/) and migrated ShipGate policy state ` +
        `(${MIGRATED_CONFIG_FILE} / ${MIGRATED_STATE_DIR}/) exist under ${root}, and no migration marker ` +
        `(${MIGRATION_MARKER}) chooses one. Refusing to combine two state roots. ` +
        `Run \`shipgate migrate cleanroom\` to complete the migration, or remove one state root.`,
    );
    this.name = "StateConflictError";
  }
}

const existsRel = (root: string, rel: string): boolean => fs.existsSync(path.join(root, rel));

export function resolveStateMode(root: string): StateMode {
  if (existsRel(root, MIGRATION_MARKER)) return "migrated";
  const legacy = existsRel(root, LEGACY_CONFIG_FILE) || existsRel(root, LEGACY_STATE_DIR);
  const migrated = existsRel(root, MIGRATED_CONFIG_FILE) || existsRel(root, MIGRATED_STATE_DIR);
  if (legacy && migrated) throw new StateConflictError(root);
  return migrated ? "migrated" : "legacy";
}

/**
 * Rebase a logical state path to the root the current mode reads and writes.
 * Non-state paths (managed workflow, package.json, source files) pass through
 * unchanged in both modes.
 */
export function resolveStateRel(root: string, logicalPath: string): string {
  if (resolveStateMode(root) === "migrated") {
    if (logicalPath === LEGACY_CONFIG_FILE) return MIGRATED_CONFIG_FILE;
    if (logicalPath === LEGACY_STATE_DIR) return MIGRATED_STATE_DIR;
    if (logicalPath.startsWith(`${LEGACY_STATE_DIR}/`)) {
      return `${MIGRATED_STATE_DIR}/${logicalPath.slice(LEGACY_STATE_DIR.length + 1)}`;
    }
  }
  return logicalPath;
}

/**
 * Internal migration seam (spec Step 6): when SHIPGATE_CLEANROOM_STATE_ROOT
 * names a directory containing `cleanroom.json` and `cleanroom/`, state reads
 * resolve there instead of the repo layout. `shipgate migrate cleanroom` uses
 * it to parity-check the staged state against the real repository BEFORE any
 * placement, without a provisional marker ever selecting unverified state.
 * Not part of the public CLI surface.
 */
export function stateRootOverride(root: string): string | null {
  const value = process.env.SHIPGATE_CLEANROOM_STATE_ROOT;
  const forRoot = process.env.SHIPGATE_CLEANROOM_STATE_ROOT_FOR;
  if (!value || value.trim().length === 0) return null;
  // The override is scoped to the migration root: ref worktrees and any other
  // root must resolve their own layout normally.
  if (!forRoot || path.resolve(forRoot) !== path.resolve(root)) return null;
  return value;
}

export function resolveStatePath(root: string, logicalPath: string): string {
  const override = stateRootOverride(root);
  if (override) {
    if (logicalPath === LEGACY_CONFIG_FILE) return path.join(override, "cleanroom.json");
    if (logicalPath === LEGACY_STATE_DIR) return path.join(override, "cleanroom");
    if (logicalPath.startsWith(`${LEGACY_STATE_DIR}/`)) {
      return path.join(override, "cleanroom", logicalPath.slice(LEGACY_STATE_DIR.length + 1));
    }
    return path.join(root, logicalPath);
  }
  return path.join(root, resolveStateRel(root, logicalPath));
}

export function resolveConfigPath(root: string): string {
  return resolveStatePath(root, LEGACY_CONFIG_FILE);
}

/**
 * Repo-relative candidates for reading state back from git history, newest
 * layout first. A base ref from before a migration still carries the legacy
 * path, and a lossless migration copies bytes unchanged, so both are valid
 * sources for the same logical file.
 */
export function stateRelCandidates(root: string, logicalPath: string): string[] {
  const actual = resolveStateRel(root, logicalPath);
  return actual === logicalPath ? [logicalPath] : [actual, logicalPath];
}
