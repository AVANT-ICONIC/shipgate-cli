import type { Command } from "commander";
import path from "node:path";
import { loadConfig } from "../config/loadConfig.js";
import { runVerification } from "../core/runner.js";
import { logger } from "../utils/logger.js";

export function registerVerifyCommand(program: Command): void {
  program
    .command("verify")
    .description("Run ShipGate verification.")
    .option("--fresh", "Run from a clean temp copy.", false)
    .option("--keep-temp", "Keep temp copy after fresh verification.", false)
    .option("--config <path>", "Path to ShipGate config.")
    .option("--json", "Print result JSON.", false)
    .option("--no-browser", "Skip browser flows.", false)
    .option("--step <name>", "Run only one named command step.")
    .action(async (options: {
      fresh?: boolean;
      keepTemp?: boolean;
      config?: string;
      json?: boolean;
      browser?: boolean;
      step?: string;
    }) => {
      const projectRoot = process.cwd();
      const loaded = await loadConfig(projectRoot, options.config);
      const result = await runVerification(projectRoot, loaded.config, {
        fresh: options.fresh,
        keepTemp: options.keepTemp,
        noBrowser: options.browser === false,
        step: options.step,
        configDir: path.dirname(loaded.path)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        logger.info("");
        logger.info(`ShipGate status: ${result.status.toUpperCase()}`);
        logger.info(`Report: ${result.reportPath}`);
        if (result.repairPromptPath) logger.info(`Repair prompt: ${result.repairPromptPath}`);
      }

      process.exitCode = result.status === "passed" ? 0 : 1;
    });
}
