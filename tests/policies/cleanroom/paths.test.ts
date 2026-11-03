import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEGACY_CONFIG_FILE,
  MIGRATED_CONFIG_FILE,
  MIGRATED_STATE_DIR,
  MIGRATION_MARKER,
  StateConflictError,
  resolveConfigPath,
  resolveStateMode,
  resolveStatePath,
  resolveStateRel,
  stateRelCandidates,
} from "../../../src/policies/cleanroom/paths.js";

function root(): string {
  return mkdtempSync(path.join(tmpdir(), "shipgate-paths-"));
}

function put(dir: string, rel: string, text = "{}"): void {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

describe("dual-mode state paths", () => {
  it("defaults to legacy mode when no state exists", () => {
    const dir = root();
    expect(resolveStateMode(dir)).toBe("legacy");
    expect(resolveStateRel(dir, ".greenroom/baseline.json")).toBe(".greenroom/baseline.json");
    expect(resolveConfigPath(dir)).toBe(path.join(dir, LEGACY_CONFIG_FILE));
  });

  it("resolves legacy state unchanged when only legacy state exists", () => {
    const dir = root();
    put(dir, LEGACY_CONFIG_FILE);
    expect(resolveStateMode(dir)).toBe("legacy");
    expect(resolveStateRel(dir, LEGACY_CONFIG_FILE)).toBe(LEGACY_CONFIG_FILE);
    expect(resolveStateRel(dir, ".greenroom/baseline.json")).toBe(".greenroom/baseline.json");
    expect(resolveStatePath(dir, ".greenroom/baseline.json")).toBe(path.join(dir, ".greenroom/baseline.json"));
    expect(stateRelCandidates(dir, ".greenroom/baseline.json")).toEqual([".greenroom/baseline.json"]);
  });

  it("rebases state paths in migrated mode chosen by the migration marker", () => {
    const dir = root();
    put(dir, LEGACY_CONFIG_FILE);
    put(dir, ".greenroom/baseline.json");
    put(dir, MIGRATION_MARKER, '{"migrated":true}');
    expect(resolveStateMode(dir)).toBe("migrated");
    expect(resolveStateRel(dir, LEGACY_CONFIG_FILE)).toBe(MIGRATED_CONFIG_FILE);
    expect(resolveStateRel(dir, ".greenroom")).toBe(MIGRATED_STATE_DIR);
    expect(resolveStateRel(dir, ".greenroom/baseline.json")).toBe(`${MIGRATED_STATE_DIR}/baseline.json`);
    expect(resolveStateRel(dir, ".greenroom/skills/repo-hygiene/SKILL.md"))
      .toBe(`${MIGRATED_STATE_DIR}/skills/repo-hygiene/SKILL.md`);
    expect(resolveConfigPath(dir)).toBe(path.join(dir, MIGRATED_CONFIG_FILE));
    expect(stateRelCandidates(dir, ".greenroom/baseline.json"))
      .toEqual([`${MIGRATED_STATE_DIR}/baseline.json`, ".greenroom/baseline.json"]);
  });

  it("uses migrated mode when only migrated state exists, even without a marker", () => {
    const dir = root();
    put(dir, MIGRATED_CONFIG_FILE);
    expect(resolveStateMode(dir)).toBe("migrated");
    expect(resolveStateRel(dir, ".greenroom/waivers.json")).toBe(`${MIGRATED_STATE_DIR}/waivers.json`);
  });

  it("never touches non-state paths in either mode", () => {
    const dir = root();
    put(dir, MIGRATION_MARKER, '{"migrated":true}');
    expect(resolveStateRel(dir, ".github/workflows/greenroom.yml")).toBe(".github/workflows/greenroom.yml");
    expect(resolveStateRel(dir, "AGENTS.md")).toBe("AGENTS.md");
    expect(resolveStateRel(dir, "package.json")).toBe("package.json");
  });

  it("fails closed with exit 2 when both state roots exist and no marker chooses one", () => {
    const dir = root();
    put(dir, LEGACY_CONFIG_FILE);
    put(dir, MIGRATED_CONFIG_FILE);
    let caught: unknown;
    try {
      resolveStateMode(dir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StateConflictError);
    const error = caught as StateConflictError;
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain(LEGACY_CONFIG_FILE);
    expect(error.message).toContain(MIGRATED_CONFIG_FILE);
    expect(error.message).toContain("migration.json");
    expect(error.message).toContain("shipgate migrate cleanroom");
  });

  it("fails closed on a partial migrated copy beside legacy state", () => {
    const dir = root();
    put(dir, ".greenroom/baseline.json");
    mkdirSync(path.join(dir, MIGRATED_STATE_DIR), { recursive: true });
    expect(() => resolveStateMode(dir)).toThrow(StateConflictError);
  });
});
