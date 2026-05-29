import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { detectProject, type ProjectProfile } from "../config/detectProject.js";
import { makeAgentsSection, makeConfigTemplate, makeSmokeSpec, makeVerifyMd } from "../profiles/templates.js";
import { logger } from "../utils/logger.js";

function writeIfSafe(file: string, content: string, force: boolean): boolean {
  if (existsSync(file) && !force) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return true;
}

function appendAgentsSection(projectRoot: string, force: boolean): boolean {
  const file = path.join(projectRoot, "AGENTS.md");
  const section = makeAgentsSection();

  if (!existsSync(file)) {
    writeFileSync(file, `# Agent Instructions\n${section}`, "utf8");
    return true;
  }

  const existing = readFileSync(file, "utf8");
  if (existing.includes("## ShipGate Verification Rule") && !force) return false;

  writeFileSync(file, `${existing.trim()}\n${section}`, "utf8");
  return true;
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize ShipGate in the current project.")
    .option("--profile <profile>", "Project profile: generic, next, vite, react, node-cli")
    .option("--force", "Overwrite existing generated files.", false)
    .action(async (options: { profile?: ProjectProfile; force?: boolean }) => {
      const projectRoot = process.cwd();
      const detected = detectProject(projectRoot);
      const profile = options.profile ?? detected.profile;
      const pm = detected.packageManager;
      const created: string[] = [];
      const skipped: string[] = [];

      const configPath = path.join(projectRoot, "shipgate.config.ts");
      if (writeIfSafe(configPath, makeConfigTemplate(profile, pm), Boolean(options.force))) {
        created.push("shipgate.config.ts");
      } else {
        skipped.push("shipgate.config.ts");
      }

      const verifyPath = path.join(projectRoot, "VERIFY.md");
      if (writeIfSafe(verifyPath, makeVerifyMd(), Boolean(options.force))) {
        created.push("VERIFY.md");
      } else {
        skipped.push("VERIFY.md");
      }

      const smokePath = path.join(projectRoot, "tests", "shipgate", "homepage.smoke.spec.ts");
      if (profile !== "node-cli" && writeIfSafe(smokePath, makeSmokeSpec(), Boolean(options.force))) {
        created.push("tests/shipgate/homepage.smoke.spec.ts");
      } else if (profile !== "node-cli") {
        skipped.push("tests/shipgate/homepage.smoke.spec.ts");
      }

      if (appendAgentsSection(projectRoot, Boolean(options.force))) {
        created.push("AGENTS.md section");
      } else {
        skipped.push("AGENTS.md section");
      }

      logger.success("ShipGate initialized.");
      if (created.length) {
        logger.info("\nCreated/updated:");
        for (const file of created) logger.info(`  - ${file}`);
      }
      if (skipped.length) {
        logger.info("\nSkipped existing:");
        for (const file of skipped) logger.info(`  - ${file}`);
      }
      logger.info("\nNext:");
      logger.info("  shipgate verify --fresh");
    });
}
