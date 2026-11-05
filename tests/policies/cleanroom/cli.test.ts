import { describe, expect, it, afterEach } from "vitest";
import { runCleanroomCli } from "../../../src/policies/cleanroom/cli.js";
import {
  LEGACY_CLI,
  OBSERVED_SITES,
  addSecondViolation,
  canonical,
  cleanupRoots,
  initOpenSpec,
  legacyExecutableSites,
  makeRoot,
  runLegacy,
  snapshot,
  type FixtureKind,
  type Run,
} from "./step5ParityHarness.js";
import { readFile } from "node:fs/promises";

// Spec issue #1 step 5 acceptance: table-driven parity between the legacy
// greenroom cli.mjs and the ported dispatcher -- exit code, stdout (JSON
// canonicalized), stderr class, and byte-exact FILESYSTEM SIDE EFFECTS, for
// every one of the 40 executable legacy process.exit sites. Coverage is
// OBSERVED: the legacy cli runs under an exit-site instrument that records
// the exact cli.mjs line whose process.exit fired (see step5ParityHarness.ts),
// and the final test asserts the observed set equals the parsed site list.
// Each step also declares the sites it intends to hit, and the observation
// must be one of them -- a declared-but-not-executed mapping fails.

type Step = {
  args: string[] | ((ctx: string) => string[]);
  sites: number[];
  exit?: number;
  stdoutSig?: string;
  stderrSig?: string;
  capture?: (legacyStdout: string) => string;
  /** Apply the same non-cli mutation to both twin roots before this step. */
  mutate?: (root: string) => Promise<void>;
};

function runPorted(args: string[], root: string): Run {
  const r = runCleanroomCli([...args, "--root", root], { cwd: root });
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, observedSite: null };
}

/**
 * Run every step against twin fixtures: legacy cli in root A, ported
 * dispatcher in root B. After EVERY step compare exit code, canonical
 * stdout/stderr, and the full byte-exact filesystem tree. Signatures are
 * asserted on the legacy run, and the observed legacy exit site must be one
 * of the step's declared sites.
 */
async function runPair(name: string, fixture: FixtureKind, steps: Step[]): Promise<void> {
  const rootA = await makeRoot(fixture);
  const rootB = await makeRoot(fixture);
  const captured: Record<string, string> = {};
  for (const [index, step] of steps.entries()) {
    const label = `${name} step ${index + 1} (${JSON.stringify(typeof step.args === "function" ? "<dynamic>" : step.args)})`;
    if (step.mutate) {
      await step.mutate(rootA);
      await step.mutate(rootB);
    }
    const args = typeof step.args === "function" ? step.args(captured.value ?? "") : step.args;
    const legacy = runLegacy(args, rootA);
    const ported = runPorted(args, rootB);
    expect(step.sites, `${label} observed legacy exit site ${legacy.observedSite}`).toContain(legacy.observedSite);
    if (step.exit !== undefined) expect(legacy.exitCode, `${label} legacy exit`).toBe(step.exit);
    expect(ported.exitCode, `${label} exit code`).toBe(legacy.exitCode);
    if (step.stdoutSig) expect(canonical(legacy.stdout, rootA), `${label} legacy stdout signature`).toContain(step.stdoutSig);
    if (step.stderrSig) expect(canonical(legacy.stderr, rootA), `${label} legacy stderr signature`).toContain(step.stderrSig);
    // stderr class parity: identical except stack bodies, which legitimately
    // differ across implementations; compare them by first line and require a
    // single failure banner.
    const legacyErr = canonical(legacy.stderr, rootA);
    const portedErr = canonical(ported.stderr, rootB);
    if (legacyErr.includes("Green Room failed:")) {
      expect(portedErr.split("\n")[0], `${label} stderr class`).toBe(legacyErr.split("\n")[0]);
      expect(portedErr.match(/Green Room failed:/g)?.length, `${label} single failure banner`).toBe(legacyErr.match(/Green Room failed:/g)?.length);
    } else {
      expect(portedErr, `${label} stderr`).toBe(legacyErr);
    }
    expect(canonical(ported.stdout, rootB), `${label} stdout`).toBe(canonical(legacy.stdout, rootA));
    if (step.capture) captured.value = step.capture(legacy.stdout);
    expect(await snapshot(rootB), `${label} filesystem side effects (byte-exact)`).toEqual(await snapshot(rootA));
  }
}

function firstViolationId(auditJson: string): string {
  const parsed = JSON.parse(auditJson) as { violations: { id: string }[] };
  const first = parsed.violations[0];
  if (!first) throw new Error("expected at least one violation in audit output");
  return first.id;
}

function firstBatchId(nextJson: string): string {
  const parsed = JSON.parse(nextJson) as { batch?: { id: string } };
  const id = parsed.batch?.id;
  if (!id) throw new Error("expected a cleanup batch in next output");
  return id;
}

afterEach(cleanupRoots);

describe("cleanroom cli dispatcher (spec Step 5)", () => {
  it("never calls process.exit: the tripwire harness patches it to throw", async () => {
    const root = await makeRoot("violation");
    const original = process.exit;
    const calls: unknown[] = [];
    process.exit = ((code?: unknown) => { calls.push(code); throw new Error(`process.exit tripwire: ${String(code)}`); }) as never;
    try {
      for (const args of [["version"], ["help"], ["check", "--root", root], ["audit", "--root", root, "--json"], ["explain"], ["waive"], ["unknown-cmd"], ["baseline", "--root", root]]) {
        const result = runCleanroomCli(args, { cwd: root });
        expect([0, 1, 2]).toContain(result.exitCode);
      }
    } finally {
      process.exit = original;
    }
    expect(calls).toEqual([]);
  }, 60_000);

  it("pins the 41 legacy process.exit occurrences (40 executable + 1 doc comment)", async () => {
    const source = await readFile(LEGACY_CLI, "utf8");
    const sites = source.split("\n").filter((line) => line.includes("process.exit("));
    // Pinned so a legacy cli.mjs change fails this test loudly.
    expect(sites.length).toBe(41);
    expect(sites.filter((line) => !line.trim().startsWith("*")).length).toBe(40);
  });

  it("parity: help, version, unknown command and the catch-all", async () => {
    await runPair("meta", "clean", [
      { args: ["help"], sites: [116], exit: 0, stdoutSig: "Green Room 1.1.0" },
      { args: ["version"], sites: [117], exit: 0, stdoutSig: "1.1.0" },
      { args: ["bogus-command"], sites: [315], exit: 2, stdoutSig: "Green Room 1.1.0" },
      { args: ["audit", "--provider", "bogus"], sites: [318], exit: 2, stderrSig: "Green Room failed: Error: Unknown provider: bogus" },
    ]);
  }, 120_000);

  it("parity: init greenfield, brownfield and greenfield-entropy refusal", async () => {
    await runPair("init-greenfield", "clean", [
      { args: ["init"], sites: [143], exit: 0, stdoutSig: "adoption baseline created" },
    ]);
    await runPair("init-brownfield", "clean", [
      { args: ["init", "--existing"], sites: [130], exit: 0, stdoutSig: "! Brownfield mode" },
    ]);
    await runPair("init-entropy", "violation", [
      { args: ["init"], sites: [138], exit: 1, stderrSig: "Greenfield initialization found existing entropy" },
    ]);
  }, 120_000);

  it("parity: audit, providers, baseline lifecycle and check gate", async () => {
    await runPair("audit-providers-baseline", "violation", [
      { args: ["init", "--existing"], sites: [130], exit: 0 },
      { args: ["baseline"], sites: [182], exit: 0, stdoutSig: "Baseline saved:" },
      { args: ["audit"], sites: [166], exit: 0 },
      { args: ["audit", "--json"], sites: [166], exit: 0 },
      { args: ["providers"], sites: [159], exit: 0, stdoutSig: "GREEN ROOM PROVIDERS" },
      { args: ["providers", "--json"], sites: [159], exit: 0 },
      { args: ["baseline"], sites: [173], exit: 2, stderrSig: "A baseline already exists." },
      { args: ["baseline", "--force"], sites: [177], exit: 2, stderrSig: "Forced re-baselining requires" },
      { args: ["baseline", "--force", "--reason", "governance rework"], sites: [182], exit: 0, stdoutSig: "Baseline saved:" },
      { args: ["check"], sites: [189], exit: 0 },
      { args: ["check"], sites: [189], exit: 1, mutate: addSecondViolation },
      { args: ["check", "--json"], sites: [189], exit: 1 },
    ]);
    await runPair("check-pass", "clean", [
      { args: ["init"], sites: [143], exit: 0 },
      { args: ["check"], sites: [189], exit: 0 },
    ]);
    await runPair("check-no-baseline", "clean", [
      { args: ["init", "--existing"], sites: [130], exit: 0 },
      { args: ["check"], sites: [187], exit: 2, stderrSig: "No Green Room baseline found" },
    ]);
  }, 180_000);

  it("parity: register and responsibility registry", async () => {
    await runPair("register", "clean", [
      { args: ["init"], sites: [143], exit: 0 },
      { args: ["register"], sites: [194], exit: 2, stderrSig: "Usage: greenroom register" },
      { args: ["register", "responsibility", "billing", "src/index.ts", "--owner", "marc", "--alias", "pay,pay2"], sites: [201], exit: 0, stdoutSig: "Registered responsibility billing" },
      { args: ["responsibility", "list"], sites: [215], exit: 0, stdoutSig: "billing" },
      { args: ["responsibility", "list", "--json"], sites: [215], exit: 0 },
      { args: ["responsibility", "show", "billing"], sites: [221], exit: 0, stdoutSig: "billing" },
      { args: ["responsibility", "show", "nope"], sites: [219], exit: 2, stderrSig: "Unknown responsibility: nope" },
      { args: ["responsibility"], sites: [223], exit: 2, stderrSig: "Usage: greenroom responsibility" },
    ]);
  }, 120_000);

  it("parity: explain, doctor and find", async () => {
    await runPair("explain-doctor", "violation", [
      { args: ["init", "--existing"], sites: [130], exit: 0 },
      { args: ["baseline"], sites: [182], exit: 0 },
      { args: ["explain"], sites: [228], exit: 2, stderrSig: "Usage: greenroom explain" },
      { args: ["explain", "v-nope"], sites: [230], exit: 2, stderrSig: "Finding not found: v-nope" },
      { args: ["audit", "--json"], sites: [166], exit: 0, capture: firstViolationId },
      { args: (ctx) => ["explain", ctx], sites: [232], exit: 0 },
      { args: ["doctor"], sites: [237], exit: 2, stderrSig: "Usage: greenroom doctor" },
      { args: ["doctor", "add a billing feature"], sites: [240], exit: 0 },
      { args: ["doctor", "add a billing feature", "--json"], sites: [240], exit: 0 },
      { args: ["find"], sites: [237], exit: 2, stderrSig: "Usage: greenroom find" },
      { args: ["find", "dup"], sites: [240], exit: 0 },
    ]);
  }, 180_000);

  it("parity: cleanup plan, next, approve, verify and openspec", async () => {
    await runPair("cleanup", "violation", [
      { args: ["init", "--existing"], sites: [130], exit: 0 },
      { args: ["baseline"], sites: [182], exit: 0 },
      { args: ["plan", "--batch-size", "0"], sites: [277], exit: 2, stderrSig: "--batch-size must be an integer from 1 to 100" },
      { args: ["plan"], sites: [291], exit: 0, stdoutSig: "Cleanup campaign written:" },
      { args: ["clean"], sites: [291], exit: 0 },
      { args: ["cleanup", "plan"], sites: [291], exit: 0 },
      { args: ["next"], sites: [286], exit: 0, stdoutSig: "GREEN ROOM NEXT CLEANUP BATCH" },
      { args: ["next", "--json"], sites: [286], exit: 0, capture: firstBatchId },
      { args: ["cleanup", "approve"], sites: [245], exit: 2, stderrSig: "Usage: greenroom cleanup approve" },
      {
        args: (ctx) => ["cleanup", "approve", ctx, "--owner", "marc", "--reason", "ok to clean", "--canonical", "none"],
        sites: [249], exit: 0, stdoutSig: "Cleanup campaign approved:",
      },
      { args: ["cleanup", "verify"], sites: [254], exit: 2, stderrSig: "Usage: greenroom cleanup verify" },
      { args: (ctx) => ["cleanup", "verify", ctx, "--no-run"], sites: [257] },
      { args: ["cleanup", "openspec"], sites: [262], exit: 2, stderrSig: "Usage: greenroom cleanup openspec" },
      { args: (ctx) => ["cleanup", "openspec", ctx, "--name", "cleanup-x", "--no-validate"], sites: [272], exit: 0, stdoutSig: "OpenSpec cleanup change created:", mutate: initOpenSpec },
    ]);
  }, 180_000);

  it("parity: waive and unwaive governance flow", async () => {
    await runPair("waivers", "violation", [
      { args: ["init", "--existing"], sites: [130], exit: 0 },
      { args: ["baseline"], sites: [182], exit: 0 },
      { args: ["waive"], sites: [296], exit: 2, stderrSig: "Usage: greenroom waive" },
      { args: ["waive", "v-nope", "--reason", "r"], sites: [298], exit: 2, stderrSig: "Violation not found in current audit:" },
      { args: ["audit", "--json"], sites: [166], exit: 0, capture: firstViolationId },
      { args: (ctx) => ["waive", ctx, "--reason", "accepted risk", "--owner", "marc", "--expires", "2027-01-01"], sites: [302], exit: 0, stdoutSig: "Waiver recorded for" },
      { args: ["audit", "--json"], sites: [166], exit: 0 },
      { args: ["unwaive"], sites: [307], exit: 2, stderrSig: "Usage: greenroom unwaive" },
      { args: ["unwaive", "v-nope"], sites: [309], exit: 2, stderrSig: "No waiver found for" },
      { args: (ctx) => ["unwaive", ctx], sites: [312], exit: 0, stdoutSig: "Waiver removed:" },
    ]);
  }, 180_000);

  it("parity: next on a clean audit", async () => {
    await runPair("next-clean", "clean", [
      { args: ["init"], sites: [143], exit: 0 },
      { args: ["next"], sites: [286], exit: 0, stdoutSig: "No cleanup batch" },
    ]);
  }, 120_000);

  // Runs last: the union of exit sites OBSERVED across every step above must
  // equal the executable sites parsed from the pinned legacy cli. This is an
  // executed-path proof, not a transcription.
  it("covers every executable legacy exit site by observation", async () => {
    const executable = await legacyExecutableSites();
    expect(executable.length).toBe(40);
    expect([...OBSERVED_SITES].sort((a, b) => a - b)).toEqual(executable);
  });
});
