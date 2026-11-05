import { spawnSync } from "node:child_process";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerPolicyCommand } from "../../../src/commands/policy.js";
import { canonical, cleanupRoots, makeRoot, runLegacy, snapshot } from "./step5ParityHarness.js";

const BIN = path.resolve("dist/cli.js");

// Spec issue #1 step 5: the Commander boundary itself is under test here --
// parity is proven against the BUILT binary (node dist/cli.js policy
// cleanroom ...), and the embedded-host tripwire proves the boundary never
// terminates the host process, including for --help/--version which
// Commander would otherwise intercept and exit on.

type BinRun = { exitCode: number | null; stdout: string; stderr: string };
function runBinary(args: string[], root: string): BinRun {
  const r = spawnSync(process.execPath, [BIN, "policy", "cleanroom", ...args, "--root", root], { encoding: "utf8" });
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function expectParity(label: string, legacy: BinRun, ported: BinRun, rootA: string, rootB: string): void {
  expect(ported.exitCode, `${label} exit`).toBe(legacy.exitCode);
  expect(canonical(ported.stdout, rootB), `${label} stdout`).toBe(canonical(legacy.stdout, rootA));
  const legacyErr = canonical(legacy.stderr, rootA);
  const portedErr = canonical(ported.stderr, rootB);
  if (legacyErr.includes("Green Room failed:")) {
    expect(portedErr.split("\n")[0], `${label} stderr class`).toBe(legacyErr.split("\n")[0]);
    expect(portedErr.match(/Green Room failed:/g)?.length, `${label} single failure banner`).toBe(legacyErr.match(/Green Room failed:/g)?.length);
  } else {
    expect(portedErr, `${label} stderr`).toBe(legacyErr);
  }
}

beforeAll(() => {
  const build = spawnSync("pnpm", ["run", "build"], { encoding: "utf8" });
  if (build.status !== 0) throw new Error(`build failed: ${build.stderr}`);
}, 180_000);

afterEach(cleanupRoots);

describe("policy cleanroom Commander boundary (spec Step 5, binary level)", () => {
  it("embedded host: --help/--version/-h/-v reach the dispatcher and never terminate the host", async () => {
    const host = new Command("host");
    host.version("99.0.0"); // host version must NOT leak into policy output
    registerPolicyCommand(host);
    const originalExit = process.exit;
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    const exitCalls: unknown[] = [];
    for (const args of [["--help"], ["-h"], ["--version"], ["-v"], ["version"], ["help"], [], ["bogus"]]) {
      exitCalls.length = 0;
      let capturedOut = "";
      let capturedErr = "";
      process.exitCode = undefined;
      process.exit = ((code?: unknown) => { exitCalls.push(code); throw new Error("host terminated"); }) as never;
      process.stdout.write = ((chunk: unknown) => { capturedOut += String(chunk); return true; }) as never;
      process.stderr.write = ((chunk: unknown) => { capturedErr += String(chunk); return true; }) as never;
      try {
        await host.parseAsync(["node", "host", "policy", "cleanroom", ...args]);
      } finally {
        process.exit = originalExit;
        process.stdout.write = originalOut as never;
        process.stderr.write = originalErr as never;
      }
      expect(exitCalls, `exit calls for ${JSON.stringify(args)}`).toEqual([]);
      expect(capturedOut).not.toContain("99.0.0");
      expect(capturedOut).not.toContain("Usage: host policy cleanroom");
      expect(capturedErr).toBe("");
      if (args[0] === "--version" || args[0] === "-v" || args[0] === "version") {
        expect(process.exitCode).toBe(0);
        expect(capturedOut).toBe("1.1.0\n");
      } else {
        expect(capturedOut).toContain("ShipGate Cleanroom policy 1.1.0");
        expect(process.exitCode).toBe(args[0] === "bogus" ? 2 : 0);
      }
      process.exitCode = undefined;
    }
  }, 60_000);

  it("binary parity: meta commands and passthrough token order", async () => {
    const rootA = await makeRoot("clean");
    const rootB = await makeRoot("clean");
    for (const args of [["version"], ["--version"], ["-v"], ["help"], ["--help"], ["-h"], [], ["bogus"], ["--json", "audit"]]) {
      expectParity(JSON.stringify(args), runLegacy(args, rootA), runBinary(args, rootB), rootA, rootB);
    }
  }, 120_000);

  it("binary parity: init, audit, check and register through the built cli, with side effects", async () => {
    const rootA = await makeRoot("violation");
    const rootB = await makeRoot("violation");
    const sequences: string[][] = [
      ["init", "--existing"],
      ["baseline"],
      ["audit", "--json"],
      ["check"],
      ["register"],
      ["register", "responsibility", "billing", "src/index.ts", "--owner", "marc"],
      ["audit", "--provider", "bogus"],
    ];
    for (const args of sequences) {
      expectParity(JSON.stringify(args), runLegacy(args, rootA), runBinary(args, rootB), rootA, rootB);
      expect(await snapshot(rootB), `tree after ${JSON.stringify(args)}`).toEqual(await snapshot(rootA));
    }
  }, 120_000);
});
