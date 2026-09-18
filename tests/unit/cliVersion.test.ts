/**
 * THE BINARY'S VERSION AND THE PACKAGE'S VERSION WERE TWO DIFFERENT FACTS.
 *
 * `src/cli.ts` carried the literal `"0.1.1"` beside a package.json that could
 * say anything. MEASURED 2026-09-18: v0.1.2 was bumped, tagged, packed and
 * published, and the tarball's `dist/cli.js` still answered 0.1.1. The name of
 * the release and its contents were different builds.
 *
 * It was caught downstream, by a consumer whose CI asks the installed binary
 * its version rather than checking that a file exists. That check should not
 * have been the only one, and this is the one that belongs here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  version: string;
};

describe("the CLI reports the package's version", () => {
  it("does not hardcode a version literal in the source", () => {
    const source = readFileSync(new URL("src/cli.ts", root), "utf8");
    expect(source).not.toMatch(/\.version\(\s*["'`]\d+\.\d+\.\d+/);
    expect(source).toMatch(/\.version\(pkg\.version\)/);
  });

  it("answers --version with exactly what package.json says, when built", () => {
    // THREE OUTCOMES. Without a build there is nothing to ask, and an
    // unanswerable question must not read as a pass.
    const cli = fileURLToPath(new URL("dist/cli.js", root));
    if (!existsSync(cli)) {
      // eslint-disable-next-line no-console
      console.warn(`COULD NOT CHECK: ${cli} is not built. This proves nothing about the version.`);
      return;
    }
    const reported = execFileSync(process.execPath, [cli, "--version"], {
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
    expect(reported).toBe(pkg.version);
  });
});
