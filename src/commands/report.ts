import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";

export function registerReportCommand(program: Command): void {
  program
    .command("report")
    .description("Print the latest ShipGate report.")
    .option("--json", "Print latest result JSON instead of markdown.", false)
    .action((options: { json?: boolean }) => {
      const file = path.join(process.cwd(), ".shipgate", options.json ? "latest-result.json" : "latest-report.md");
      if (!existsSync(file)) {
        console.error("No ShipGate report found. Run shipgate verify first.");
        process.exitCode = 2;
        return;
      }
      console.log(readFileSync(file, "utf8"));
    });
}
