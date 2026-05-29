import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execaCommand } from "execa";
import type { Command } from "commander";
import { detectPackageManager } from "../config/detectProject.js";
import { logger } from "../utils/logger.js";

const DEFAULT_REPO = "AVANT-ICONIC/shipgate-cli";

export type UpdateScope = "global" | "local";
export type UpdateSource = "github" | "npm";

export type UpdatePlan = {
  source: UpdateSource;
  scope: UpdateScope;
  version: string;
  command: string;
  packageUrl?: string;
};

type GithubRelease = {
  tag_name?: unknown;
  draft?: unknown;
};

function packageVersionFromTag(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

function normalizeVersion(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Version must not be empty.");
  if (trimmed === "latest") return trimmed;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function githubTarballUrl(repo: string, tag: string): string {
  const version = packageVersionFromTag(tag);
  return `https://github.com/${repo}/releases/download/${tag}/shipgate-cli-${version}.tgz`;
}

function localAddCommand(projectRoot: string, target: string): string {
  const packageManager = detectPackageManager(projectRoot);
  if (packageManager === "npm") return `npm install -D ${target}`;
  if (packageManager === "yarn") return `yarn add -D ${target}`;
  if (packageManager === "bun") return `bun add -d ${target}`;
  return `pnpm add -D ${target}`;
}

function projectHasLocalInstall(projectRoot: string, invokedBin: string | undefined): boolean {
  if (!invokedBin) return existsSync(path.join(projectRoot, "node_modules", ".bin", "shipgate"));

  const normalizedBin = path.resolve(invokedBin);
  if (normalizedBin.startsWith(path.join(projectRoot, "node_modules"))) return true;

  try {
    const realBin = realpathSync(invokedBin);
    return realBin.startsWith(path.join(projectRoot, "node_modules"));
  } catch {
    return existsSync(path.join(projectRoot, "node_modules", ".bin", "shipgate"));
  }
}

export function detectUpdateScope(projectRoot: string, invokedBin = process.argv[1]): UpdateScope {
  return projectHasLocalInstall(projectRoot, invokedBin) ? "local" : "global";
}

export function makeUpdatePlan(options: {
  projectRoot: string;
  source: UpdateSource;
  scope: UpdateScope;
  version: string;
  repo?: string;
}): UpdatePlan {
  const repo = options.repo ?? DEFAULT_REPO;
  const version = normalizeVersion(options.version);

  if (options.source === "npm") {
    const target = version === "latest" ? "@shipgate/cli@latest" : `@shipgate/cli@${packageVersionFromTag(version)}`;
    const command = options.scope === "global"
      ? `npm install -g ${target}`
      : localAddCommand(options.projectRoot, target);

    return {
      source: "npm",
      scope: options.scope,
      version,
      command
    };
  }

  const packageUrl = githubTarballUrl(repo, version);
  const command = options.scope === "global"
    ? `npm install -g ${packageUrl}`
    : localAddCommand(options.projectRoot, packageUrl);

  return {
    source: "github",
    scope: options.scope,
    version,
    command,
    packageUrl
  };
}

async function latestGithubTag(repo: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    headers: {
      "accept": "application/vnd.github+json",
      "user-agent": "shipgate-cli"
    }
  });

  if (!response.ok) {
    throw new Error(`Could not fetch GitHub releases for ${repo}: HTTP ${response.status}`);
  }

  const releases = await response.json() as GithubRelease[];
  const release = releases.find((candidate) => candidate.draft !== true && typeof candidate.tag_name === "string");
  if (!release || typeof release.tag_name !== "string") {
    throw new Error(`No GitHub releases found for ${repo}.`);
  }

  return release.tag_name;
}

async function installedVersion(): Promise<string> {
  for (const relativePath of ["../package.json", "../../package.json"]) {
    try {
      const packageJson = JSON.parse(
        await readFile(new URL(relativePath, import.meta.url), "utf8")
      ) as { version?: unknown };
      return typeof packageJson.version === "string" ? packageJson.version : "unknown";
    } catch {
      // Try the next path. Bundled and source execution live at different depths.
    }
  }

  return "unknown";
}

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("Print or run the command that updates ShipGate.")
    .option("--target <version>", "Version/tag to install. Defaults to latest GitHub release, including prereleases.", "latest")
    .option("--source <source>", "Update source: github or npm.", "github")
    .option("--repo <repo>", "GitHub repository for release tarballs.", DEFAULT_REPO)
    .option("--global", "Update a global install.")
    .option("--local", "Update a project-local dev dependency.")
    .option("--yes", "Run the update command instead of only printing it.", false)
    .action(async (options: {
      target: string;
      source: string;
      repo: string;
      global?: boolean;
      local?: boolean;
      yes?: boolean;
    }) => {
      if (options.source !== "github" && options.source !== "npm") {
        throw new Error("--source must be one of: github, npm.");
      }
      if (options.global && options.local) {
        throw new Error("Choose either --global or --local, not both.");
      }

      const projectRoot = process.cwd();
      const scope = options.global ? "global" : options.local ? "local" : detectUpdateScope(projectRoot);
      const version = options.target === "latest" && options.source === "github"
        ? await latestGithubTag(options.repo)
        : options.target;
      const plan = makeUpdatePlan({
        projectRoot,
        source: options.source,
        scope,
        version,
        repo: options.repo
      });

      logger.info(`ShipGate installed version: ${await installedVersion()}`);
      logger.info(`Update target: ${plan.version} (${plan.source}, ${plan.scope})`);
      logger.info("");
      logger.info(plan.command);

      if (!options.yes) {
        logger.info("");
        logger.info("Run with --yes to execute this command.");
        return;
      }

      const result = await execaCommand(plan.command, {
        shell: true,
        stdio: "inherit",
        reject: false
      });

      process.exitCode = result.exitCode ?? 1;
    });
}
