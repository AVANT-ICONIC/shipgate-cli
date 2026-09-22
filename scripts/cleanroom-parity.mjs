#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VOLATILE_KEYS = new Set([
  "timestamp", "startedAt", "finishedAt", "createdAt", "updatedAt",
  "duration", "durationMs", "elapsed", "elapsedMs", "tempRoot", "temporaryRoot"
]);
const PROSE_KEYS = new Set(["message", "text", "summary", "description", "warning", "error"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalize(value, roots = [], key = "") {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, roots, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([childKey]) => !VOLATILE_KEYS.has(childKey))
      .map(([childKey, child]) => [childKey, canonicalize(child, roots, childKey)]));
  }
  if (typeof value !== "string") return value;

  let normalized = value;
  for (const root of roots.filter(Boolean).sort((a, b) => b.length - a.length)) {
    normalized = normalized.split(root).join("<repo-root>");
  }
  if (PROSE_KEYS.has(key)) {
    normalized = normalized.replace(/\bGreen Room\b/g, "Cleanroom");
  }
  return normalized;
}

function git(repo, args, allowFailure = false) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr || result.stdout).trim()}`);
  }
  return String(result.stdout).trim();
}

function repositoryFor(file) {
  const directory = path.dirname(realpathSync(file));
  const root = git(directory, ["rev-parse", "--show-toplevel"]);
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  return { root, commit: git(root, ["rev-parse", "HEAD"]), dirty: Boolean(dirty), dirtyStatus: dirty };
}

function commandFor(cli) {
  const resolved = realpathSync(cli);
  return /\.[cm]?js$/u.test(resolved) ? [process.execPath, resolved] : [resolved];
}

export function runCli(cli, repo, ref) {
  const [command, ...prefix] = commandFor(cli);
  const env = { ...process.env };
  for (const envKey of Object.keys(env)) {
    if (envKey.startsWith("GREENROOM_ALLOW_") || envKey === "GREENROOM_COMPARE_REF" || envKey === "GREENROOM_BASE_REF") {
      delete env[envKey];
    }
  }
  const against = ref === "auto" ? [] : [`--against=${ref}`];
  const result = spawnSync(command, [...prefix, "check", ...against, "--json"], {
    cwd: repo, env, encoding: "utf8"
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
  return { exitCode: result.status, stdout, stderr, json, compareRef: json.compareRef ?? null };
}

export function compareRuns(legacy, shipgate, roots = []) {
  const left = { exitCode: legacy.exitCode, result: canonicalize(legacy.json, roots) };
  const right = { exitCode: shipgate.exitCode, result: canonicalize(shipgate.json, roots) };
  const leftText = `${JSON.stringify(left, null, 2)}\n`;
  const rightText = `${JSON.stringify(right, null, 2)}\n`;
  return {
    legacy: left, shipgate: right,
    legacyDigest: sha256(leftText), shipgateDigest: sha256(rightText), equal: leftText === rightText
  };
}

export function runParity({ repo, legacyCli, shipgateCli, ref, output }) {
  const root = realpathSync(repo);
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  if (dirty) throw new Error(`refusing dirty worktree at ${root}:\n${dirty}`);

  const legacyTool = repositoryFor(legacyCli);
  const shipgateTool = repositoryFor(shipgateCli);
  const legacy = runCli(legacyCli, root, ref);
  const shipgate = runCli(shipgateCli, root, ref);
  const comparison = compareRuns(legacy, shipgate, [root]);
  const manifest = {
    schemaVersion: 1,
    runtime: { node: process.version },
    repository: {
      remote: git(root, ["remote", "get-url", "origin"]),
      commit: git(root, ["rev-parse", "HEAD"]),
      branch: git(root, ["branch", "--show-current"]), ref
    },
    tools: {
      legacy: { command: realpathSync(legacyCli), exitCode: legacy.exitCode, compareRef: legacy.compareRef, repository: legacyTool },
      shipgate: { command: realpathSync(shipgateCli), exitCode: shipgate.exitCode, compareRef: shipgate.compareRef, repository: shipgateTool }
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
    const separator = arg.indexOf("=");
    const rawKey = arg.slice(2, separator < 0 ? undefined : separator);
    const inline = separator < 0 ? undefined : arg.slice(separator + 1);
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

const entry = process.argv[1];
const isMain = entry && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
if (isMain) {
  try {
    runParity(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
