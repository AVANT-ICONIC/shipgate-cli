import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectPackageManager, detectProject } from "../../src/config/detectProject.js";

function fixture(): string {
  const dir = path.join(tmpdir(), `shipgate-test-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("detectProject", () => {
  it("detects pnpm by lockfile", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  it("detects the package manager declared by package.json", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      packageManager: "npm@10.8.0"
    }));
    expect(detectPackageManager(dir)).toBe("npm");
  });

  it("detects vite project", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      dependencies: { vite: "^5.0.0" }
    }));
    expect(detectProject(dir).profile).toBe("vite");
  });

  it("detects node cli project", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      bin: { demo: "./dist/cli.js" }
    }));
    expect(detectProject(dir).profile).toBe("node-cli");
  });
});
