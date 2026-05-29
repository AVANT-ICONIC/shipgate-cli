import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type ProjectProfile =
  | "next"
  | "vite"
  | "react"
  | "node-cli"
  | "generic";

type PackageJson = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  bin?: unknown;
  packageManager?: unknown;
};

export type DetectedProject = {
  profile: ProjectProfile;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  packageJson?: PackageJson;
};

export function readPackageJson(projectRoot: string): PackageJson | undefined {
  const file = path.join(projectRoot, "package.json");
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as PackageJson;
}

export function detectPackageManager(projectRoot: string): "npm" | "pnpm" | "yarn" | "bun" {
  let packageJson: PackageJson | undefined;
  try {
    packageJson = readPackageJson(projectRoot);
  } catch {
    packageJson = undefined;
  }
  const declaredPackageManager = typeof packageJson?.packageManager === "string"
    ? packageJson.packageManager.split("@")[0]
    : undefined;

  if (
    declaredPackageManager === "npm" ||
    declaredPackageManager === "pnpm" ||
    declaredPackageManager === "yarn" ||
    declaredPackageManager === "bun"
  ) {
    return declaredPackageManager;
  }

  if (existsSync(path.join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(projectRoot, "bun.lock")) || existsSync(path.join(projectRoot, "bun.lockb"))) return "bun";
  if (existsSync(path.join(projectRoot, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(projectRoot, "package-lock.json"))) return "npm";
  return "pnpm";
}

export function detectProject(projectRoot: string): DetectedProject {
  const packageJson = readPackageJson(projectRoot);
  const deps = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {})
  };

  const has = (dep: string) => Object.prototype.hasOwnProperty.call(deps, dep);
  const file = (name: string) => existsSync(path.join(projectRoot, name));

  let profile: ProjectProfile = "generic";

  if (has("next") || file("next.config.js") || file("next.config.ts") || file("next.config.mjs")) {
    profile = "next";
  } else if (has("vite") || file("vite.config.ts") || file("vite.config.js") || file("vite.config.mjs")) {
    profile = "vite";
  } else if (packageJson?.bin) {
    profile = "node-cli";
  } else if (has("react")) {
    profile = "react";
  }

  return {
    profile,
    packageManager: detectPackageManager(projectRoot),
    packageJson
  };
}

export function pmRun(pm: string, script: string): string {
  if (pm === "npm") return `npm run ${script}`;
  if (pm === "yarn") return `yarn ${script}`;
  if (pm === "bun") return `bun run ${script}`;
  return `pnpm ${script}`;
}

export function pmInstall(pm: string): string {
  if (pm === "npm") return "npm ci";
  if (pm === "yarn") return "yarn install --immutable";
  if (pm === "bun") return "bun install --frozen-lockfile";
  return "pnpm install --frozen-lockfile";
}
