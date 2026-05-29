import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFreshCopy } from "../../src/core/freshCopy.js";

function fixture(): string {
  const dir = path.join(tmpdir(), `shipgate-copy-test-${Date.now()}-${Math.random()}`);
  mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), "{}");
  writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
  writeFileSync(path.join(dir, ".env"), "SECRET=1");
  writeFileSync(path.join(dir, ".env.production"), "SECRET=production");
  writeFileSync(path.join(dir, "node_modules", "x.txt"), "nope");
  mkdirSync(path.join(dir, ".shipgate", "reports"), { recursive: true });
  writeFileSync(path.join(dir, ".shipgate", "latest-result.json"), "{}");
  writeFileSync(path.join(dir, ".shipgate", "reports", "stale-report.md"), "nope");
  mkdirSync(path.join(dir, "packages", "app", "node_modules"), { recursive: true });
  mkdirSync(path.join(dir, "packages", "app", "dist"), { recursive: true });
  mkdirSync(path.join(dir, "packages", "app", ".shipgate", "artifacts"), { recursive: true });
  writeFileSync(path.join(dir, "packages", "app", "package.json"), "{}");
  writeFileSync(path.join(dir, "packages", "app", ".env"), "SECRET=2");
  writeFileSync(path.join(dir, "packages", "app", ".env.test"), "SECRET=test");
  writeFileSync(path.join(dir, "packages", "app", "node_modules", "x.txt"), "nope");
  writeFileSync(path.join(dir, "packages", "app", "dist", "bundle.js"), "nope");
  writeFileSync(path.join(dir, "packages", "app", ".shipgate", "artifacts", "log.txt"), "nope");
  return dir;
}

describe("fresh copy", () => {
  it("preserves lockfile and excludes node_modules and env", async () => {
    const dir = fixture();
    const copy = await createFreshCopy(dir);
    expect(existsSync(path.join(copy.tempRoot, "package.json"))).toBe(true);
    expect(existsSync(path.join(copy.tempRoot, "pnpm-lock.yaml"))).toBe(true);
    expect(existsSync(path.join(copy.tempRoot, "packages", "app", "package.json"))).toBe(true);
    expect(existsSync(path.join(copy.tempRoot, ".env"))).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, ".env.production"))).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, ".shipgate"))).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, "node_modules"))).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, "packages", "app", ".env"))).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, "packages", "app", ".env.test"))).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, "packages", "app", "node_modules"))).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, "packages", "app", "dist"))).toBe(false);
    expect(existsSync(path.join(copy.tempRoot, "packages", "app", ".shipgate", "artifacts"))).toBe(false);
    await copy.cleanup();
    await rm(dir, { recursive: true, force: true });
  });
});
