#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VOLATILE_KEYS = new Set([
  "timestamp", "startedAt", "finishedAt", "createdAt", "updatedAt",
  "duration", "durationMs", "elapsed", "elapsedMs", "tempRoot", "temporaryRoot"
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalize(value, roots = []) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, roots));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !VOLATILE_KEYS.has(key))
      .map(([key, child]) => [key, canonicalize(child, roots)]));
  }
  if (typeof value !== "string") return value;

  let normalized = value;
  for (const root of roots.filter(Boolean).sort((a, b) => b.length - a.length)) {
    normalized = normalized.split(root).join("<repo-root>");
  }
  return normalized
    .replace(/\bGreen Room\b/g, "Cleanroom")
    .replace(/\bgreenroom\b/g, "cleanroom");
}

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr || result.stdout).trim()}`);
  }
  return String(result.stdout).trim();
}

function commandFor(cli) {
  const resolved = path.resolve(cli);
  return /\.[cm]?js$/u.test(resolved) ? [process.execPath, resolved] : [resolved];
}

export function runCli(cli, repo, ref) {
  const [command, ...prefix] = commandFor(cli);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GREENROOM_ALLOW_") || key === "GREENROOM_COMPARE_REF" || key === "GREENROOM_BASE_REF") {
      delete env[key];
    }
  }
  const result = spawnSync(command, [...prefix, "check", `--against=${ref}`, "--json"], {
    cwd: repo,
    env,
    encoding: "utf8"
  });
  if (result.error) throw result.error;
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if (!stdout.trim()) throw new Error(`${cli} produced no JSON output (exit ${result.status ?? "unknown"}): ${stderr.trim()}`);

  let json;
  try {
    json = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${cli} produced invalid JSON (exit ${result.status ?? "unknown"}): ${error.message}`);
  }
  return { exitCode: result.status, stdout, stderr, json };
}

export function compareRuns(legacy, shipgate, roots = []) {
  const left = { exitCode: legacy.exitCode, result: canonicalize(legacy.json, roots) };
  const right = { exitCode: shipgate.exitCode, result: canonicalize(shipgate.json, roots) };
  const leftText = `${JSON.stringify(left, null, 2)}\n`;
  const rightText = `${JSON.stringify(right, null, 2)}\n`;
  return {
    legacy: left,
    shipgate: right,
    legacyDigest: sha256(leftText),
    shipgateDigest: sha256(rightText),
    equal: leftText === rightText
  };
}

export function runParity({ repo, legacyCli, shipgateCli, ref, output }) {
  const root = path.resolve(repo);
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  if (dirty) throw new Error(`refusing dirty worktree at ${root}:\n${dirty}`);

  const commit = git(root, ["rev-parse", "HEAD"]);
  const remote = git(root, ["remote", "get-url", "origin"]);
  const legacy = runCli(legacyCli, root, ref);
  const shipgate = runCli(shipgateCli, root, ref);
  const comparison = compareRuns(legacy, shipgate, [root]);
  const manifest = {
    schemaVersion: 1,
    repository: { remote, commit, ref },
    tools: {
      legacy: { command: path.resolve(legacyCli), exitCode: legacy.exitCode },
      shipgate: { command: path.resolve(shipgateCli), exitCode: shipgate.exitCode }
    },
    raw: {
      legacy: { stdout: legacy.stdout, stderr: legacy.stderr },
      shipgate: { stdout: shipgate.stdout, stderr: shipgate.stderr }
    },
    canonical: comparison,
    verdict: comparison.equal ? "zero-diff" : "different"
  };

  mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  writeFileSync(path.resolve(output), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (!comparison.equal) throw new Error(`semantic parity failed; manifest written to ${path.resolve(output)}`);
  return manifest;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const [rawKey, inline] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = inline ?? argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${rawKey}`);
    options[key] = value;
  }
  for (const key of ["repo", "legacyCli", "shipgateCli", "ref", "output"]) {
    if (!options[key]) throw new Error(`missing required --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  return options;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    runParity(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
