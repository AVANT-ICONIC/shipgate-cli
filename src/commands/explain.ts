import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import type { VerificationResult } from "../config/schema.js";
import {
  createVerificationExplanation,
  formatVerificationExplanation
} from "../core/explainer.js";

export function registerExplainCommand(program: Command): void {
  program
    .command("explain")
    .description("Explain the latest ShipGate verification result.")
    .option("--json", "Print structured explanation JSON instead of markdown.", false)
    .action((options: { json?: boolean }) => {
      const file = path.join(process.cwd(), ".shipgate", "latest-result.json");
      if (!existsSync(file)) {
        console.error("No ShipGate result found. Run shipgate verify first.");
        process.exitCode = 2;
        return;
      }

      let result: VerificationResult;
      try {
        result = JSON.parse(readFileSync(file, "utf8")) as VerificationResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Could not read ShipGate result JSON: ${message}`);
        process.exitCode = 2;
        return;
      }

      if (options.json) {
        process.stdout.write(`${JSON.stringify(createVerificationExplanation(result), null, 2)}\n`);
      } else {
        process.stdout.write(formatVerificationExplanation(result));
      }
    });
}
