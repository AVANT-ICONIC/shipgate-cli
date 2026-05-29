import { existsSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { detectProject } from "../config/detectProject.js";
import { findConfig } from "../config/loadConfig.js";
import { logger } from "../utils/logger.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check local ShipGate readiness.")
    .action(async () => {
      const root = process.cwd();
      const detected = detectProject(root);
      const configPath = await findConfig(root);

      logger.info("ShipGate doctor\n");
      logger.info(`Node: ${process.version}`);
      logger.info(`Project profile: ${detected.profile}`);
      logger.info(`Package manager: ${detected.packageManager}`);
      logger.info(`package.json: ${existsSync(path.join(root, "package.json")) ? "found" : "missing"}`);
      logger.info(`ShipGate config: ${configPath ?? "missing"}`);

      try {
        await import("playwright");
        logger.info("Playwright: import ok");
      } catch {
        logger.warn("Playwright: not available. Browser checks will fail until installed.");
      }
    });
}
