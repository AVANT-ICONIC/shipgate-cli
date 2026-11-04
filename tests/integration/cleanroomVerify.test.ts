import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/loadConfig.js";
import { runVerification } from "../../src/core/runner.js";
import { initialize } from "../../src/policies/cleanroom/init.mjs";
import { loadConfig as loadCleanroomConfig } from "../../src/policies/cleanroom/config.mjs";
import { scan } from "../../src/policies/cleanroom/scanner.mjs";
import { makeBaseline } from "../../src/policies/cleanroom/baseline.mjs";

// Spec Step 4: the registered Cleanroom policy pack runs inside `shipgate
// verify` after the path policy and required-files preflight and before
// hooks and build/test commands, returns PolicyResult values (never exits),
// and lands one policy JSON artifact in the run directory, the result JSON,
// the markdown/HTML reports, the artifact index, and the repair prompt.

const roots: string[] = [];
const TRIVIAL = "node -e \"process.exitCode = 0\"";

type RepoOptions = {
  violation?: boolean;
  baseline?: boolean;
  enabled?: boolean;
  origin?: boolean;
  hooks?: boolean;
  stopOnFirst?: boolean;
};

async function makeRepo(options: RepoOptions = {}): Promise<string> {
  const {
    violation = false,
    baseline = true,
    enabled = true,
    origin = false,
    hooks = false,
    stopOnFirst
  } = options;
  const root = await mkdtemp(path.join(tmpdir(), "shipgate-cleanroom-verify-"));
  roots.push(root);
  const git = (...args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");

  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "policy-fixture", private: true, type: "module" }, null, 2) + "\n");
  await writeFile(path.join(root, "README.md"), "fixture\n");
  initialize(root, { existing: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export const clean = true;\n");
  if (baseline) {
    const config = loadCleanroomConfig(root);
    makeBaseline(root, config, scan(root, config));
  }

  const config: Record<string, unknown> = {
    packageManager: "npm",
    commands: { test: TRIVIAL, build: TRIVIAL },
    policies: { cleanroom: { enabled } }
  };
  if (hooks) config.hooks = { beforeVerify: [{ name: "before-gate", command: TRIVIAL }] };
  if (typeof stopOnFirst === "boolean") config.failurePolicy = { stopOnFirstCommandFailure: stopOnFirst };
  await writeFile(path.join(root, "shipgate.config.json"), JSON.stringify(config, null, 2) + "\n");

  git("add", "-A");
  git("commit", "-qm", "baseline");

  if (origin) {
    const bare = await mkdtemp(path.join(tmpdir(), "shipgate-cleanroom-origin-"));
    roots.push(bare);
    spawnSync("git", ["init", "--bare", "-q", bare]);
    git("remote", "add", "origin", bare);
    git("push", "-qu", "origin", "main");
    git("checkout", "-qb", "feature");
  }

  if (violation) {
    const dup = Array.from({ length: 30 }, (_, i) => `export const line${i} = "duplicate-content-${i}";`).join("\n") + "\n";
    await writeFile(path.join(root, "src", "dup-a.ts"), dup);
    await writeFile(path.join(root, "src", "dup-b.ts"), dup);
    git("add", "-A");
    git("commit", "-qm", "duplicate violation");
  }

  return root;
}

async function verify(root: string, options: { fresh?: boolean; step?: string } = {}) {
  const loaded = await loadConfig(root);
  return runVerification(root, loaded.config, { ...options, configDir: path.dirname(loaded.path) });
}

function policyStep(result: Awaited<ReturnType<typeof verify>>) {
  return result.steps.find((step) => step.id === "policy:cleanroom");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cleanroom policy in shipgate verify (spec Step 4)", () => {
  it("runs after required-files preflight and before beforeVerify hooks and build/test commands", async () => {
    const root = await makeRepo({ hooks: true });
    const result = await verify(root);
    expect(result.status).toBe("passed");
    expect(result.steps.map((step) => step.id)).toEqual([
      "preflight:required-files",
      "policy:cleanroom",
      "hook:beforeVerify:before-gate",
      "test",
      "build"
    ]);
    expect(policyStep(result)?.status).toBe("passed");
  }, 15_000);

  it("runs against the fresh copy under --fresh with identical compare ref and findings", async () => {
    const root = await makeRepo({ violation: true, origin: true });
    const inPlace = await verify(root);
    const fresh = await verify(root, { fresh: true });
    expect(fresh.verificationRoot).not.toBe(root);
    const inPlacePolicy = policyStep(inPlace);
    const freshPolicy = policyStep(fresh);
    expect(inPlacePolicy?.status).toBe("failed");
    expect(freshPolicy?.status).toBe("failed");
    expect(freshPolicy?.details?.compareRef).toBe(inPlacePolicy?.details?.compareRef);
    expect(freshPolicy?.details?.findings).toEqual(inPlacePolicy?.details?.findings);
  }, 30_000);

  it("honors --step policy:cleanroom and skips the pack for other selected steps", async () => {
    const root = await makeRepo();
    const selected = await verify(root, { step: "policy:cleanroom" });
    expect(selected.steps.map((step) => step.id)).toEqual(["preflight:required-files", "policy:cleanroom"]);
    expect(selected.status).toBe("passed");

    const other = await verify(root, { step: "test" });
    expect(policyStep(other)).toBeUndefined();
    expect(other.steps.map((step) => step.id)).toEqual(["preflight:required-files", "test"]);
  }, 15_000);

  it("stays silent when disabled and reports skipped when a disabled pack is explicitly selected", async () => {
    const root = await makeRepo({ enabled: false });
    const result = await verify(root);
    expect(result.status).toBe("passed");
    expect(policyStep(result)).toBeUndefined();

    const selected = await verify(root, { step: "policy:cleanroom" });
    expect(selected.status).toBe("passed");
    expect(policyStep(selected)?.status).toBe("skipped");
    expect(policyStep(selected)?.details?.policyStatus).toBe("disabled");
  }, 15_000);

  it("blocks with exit code 1 on a fresh violation and never exits the process", async () => {
    const root = await makeRepo({ violation: true });
    const result = await verify(root);
    const step = policyStep(result);
    expect(result.status).toBe("failed");
    expect(step?.status).toBe("failed");
    expect(step?.exitCode).toBe(1);
    expect(step?.details?.policyStatus).toBe("blocked");
    expect(Array.isArray(step?.details?.findings) && step.details.findings.length).toBeGreaterThan(0);
  }, 15_000);

  it("returns exit code 2 (invalid) when the baseline is missing", async () => {
    const root = await makeRepo({ baseline: false });
    const result = await verify(root);
    const step = policyStep(result);
    expect(result.status).toBe("failed");
    expect(step?.exitCode).toBe(2);
    expect(step?.details?.policyStatus).toBe("invalid");
    expect(step?.error).toContain("baseline");
  }, 15_000);

  it("continues build/test after a blocking finding when the failure policy permits it", async () => {
    const root = await makeRepo({ violation: true, stopOnFirst: false });
    const result = await verify(root);
    expect(result.status).toBe("failed");
    expect(result.steps.map((step) => step.id)).toEqual([
      "preflight:required-files",
      "policy:cleanroom",
      "test",
      "build"
    ]);
    expect(result.steps.find((step) => step.id === "test")?.status).toBe("passed");
    expect(result.steps.find((step) => step.id === "build")?.status).toBe("passed");
  }, 15_000);

  it.each([true, false])(
    "writes the policy artifact, JSON result, report, artifact index, and repair prompt on a blocking finding (stopOnFirst=%s)",
    async (stopOnFirst) => {
      const root = await makeRepo({ violation: true, stopOnFirst });
      const result = await verify(root);
      expect(result.status).toBe("failed");

      const step = policyStep(result);
      const policyArtifacts = step?.artifacts ?? [];
      expect(policyArtifacts.length).toBe(1);
      const artifactPath = policyArtifacts[0]!.path;
      expect(existsSync(artifactPath)).toBe(true);
      const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
      expect(Array.isArray(artifact.findings)).toBe(true);

      const resultJson = JSON.parse(await readFile(path.join(root, ".shipgate", "latest-result.json"), "utf8"));
      expect(resultJson.steps.some((s: { id: string }) => s.id === "policy:cleanroom")).toBe(true);

      const report = await readFile(path.join(root, ".shipgate", "latest-report.md"), "utf8");
      expect(report).toContain("Policy status: blocked");
      expect(report).toContain("Findings (");
      expect(report).toContain("cleanroom policy result");

      const repair = await readFile(path.join(root, ".shipgate", "latest-repair-prompt.md"), "utf8");
      expect(repair).toContain("Policy status: blocked");
      expect(repair).toContain("Policy findings (");
      expect(repair).toContain("duplication/");
    }, 20_000);
});
