import { copyFileSync, cpSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initialize } from "../../../src/policies/cleanroom/init.mjs";
import { loadConfig } from "../../../src/policies/cleanroom/config.mjs";
import { loadBaseline, makeBaseline } from "../../../src/policies/cleanroom/baseline.mjs";
import { addWaiver, loadWaivers, waiversHash } from "../../../src/policies/cleanroom/waivers.mjs";
import { loadRegistry } from "../../../src/policies/cleanroom/analyzers/registry.mjs";
import { loadGeneratedRegistry } from "../../../src/policies/cleanroom/analyzers/generated.mjs";
import { generatedHash, policyHash, registryHash } from "../../../src/policies/cleanroom/integrity.mjs";
import { scan } from "../../../src/policies/cleanroom/scanner.mjs";
import { evaluateCheck } from "../../../src/policies/cleanroom/check.mjs";
import { StateConflictError } from "../../../src/policies/cleanroom/paths.js";

/**
 * Spec Step 3 acceptance: byte-identical legacy reads and migrated reads must
 * produce identical config, baseline, registry, generated registry, waivers,
 * hashes, scan result, and check result. The migration simulated here is the
 * byte-for-byte copy Step 6 performs, marker included, legacy state kept.
 */

function put(root: string, rel: string, text: string): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function legacyFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "shipgate-legacy-state-"));
  put(root, "src/index.ts", "export const answer: number = 42;\n");
  initialize(root);
  const config = loadConfig(root) as never;
  addWaiver(
    root,
    config,
    { id: "v-fixture", rule: "fixture/rule", paths: ["src/index.ts"] },
    { reason: "fixture waiver", owner: "instinct", expiresAt: "2099-01-01" },
  );
  const result = scan(root, config) as never;
  makeBaseline(root, config, result);
  return root;
}

function snapshot(root: string) {
  const config = loadConfig(root) as never;
  return {
    config,
    baseline: loadBaseline(root, config),
    registry: loadRegistry(root, config),
    generated: loadGeneratedRegistry(root, config),
    waivers: loadWaivers(root, config),
    policyHash: policyHash(root),
    registryHash: registryHash(root, config),
    generatedHash: generatedHash(root, config),
    waiversHash: waiversHash(root, config),
    scan: scan(root, config),
    check: evaluateCheck(root, {}),
  };
}

function migrateBytes(root: string): void {
  mkdirSync(path.join(root, ".shipgate/policies"), { recursive: true });
  copyFileSync(path.join(root, ".greenroom.json"), path.join(root, ".shipgate/policies/cleanroom.json"));
  cpSync(path.join(root, ".greenroom"), path.join(root, ".shipgate/policies/cleanroom"), { recursive: true });
  put(root, ".shipgate/policies/cleanroom/migration.json", JSON.stringify({ source: "fixture", completedAt: "2026-01-01T00:00:00.000Z" }));
}

describe("dual-mode state reads", () => {
  it("produces identical state, hashes, scan, and check results from byte-identical migrated state", () => {
    const root = legacyFixture();
    const legacy = snapshot(root);
    expect((legacy.check as { exitCode: number }).exitCode).not.toBe(2);
    migrateBytes(root);
    const migrated = snapshot(root);
    expect(migrated).toEqual(legacy);
  });

  it("refuses to combine two state roots without a migration marker", () => {
    const root = legacyFixture();
    mkdirSync(path.join(root, ".shipgate/policies"), { recursive: true });
    copyFileSync(path.join(root, ".greenroom.json"), path.join(root, ".shipgate/policies/cleanroom.json"));
    cpSync(path.join(root, ".greenroom"), path.join(root, ".shipgate/policies/cleanroom"), { recursive: true });
    let caught: unknown;
    try {
      loadConfig(root);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StateConflictError);
    expect((caught as StateConflictError).exitCode).toBe(2);
    expect((caught as StateConflictError).message).toContain("shipgate migrate cleanroom");
    expect(() => snapshot(root)).toThrow(StateConflictError);
  });
});
