import type { Command } from "commander";
import { migrateCleanroom } from "../policies/cleanroom/migrate.js";

/**
 * Spec issue #1 step 6: Commander boundary for lossless policy migration.
 * Like every ShipGate entry point it only assigns `process.exitCode`; all
 * logic, output and exit codes live in the policy module so the command is
 * safe in embedded hosts.
 */
export function registerMigrateCommand(program: Command): void {
  program
    .command("migrate")
    .description("Migrate a ported tool's legacy state into ShipGate.")
    .enablePositionalOptions()
    .command("cleanroom")
    .description("Migrate legacy Cleanroom state (.greenroom.json + .greenroom/) into .shipgate/policies/.")
    .option("--root <path>", "repository root")
    .option("--dry-run", "validate and print the plan without changing anything", false)
    .option("--json", "print a machine-readable result", false)
    .option("--legacy-cli <path>", "path to the legacy Cleanroom CLI script (cli.mjs); overrides auto-detection")
    .action((options: { root?: string; dryRun: boolean; json: boolean; legacyCli?: string }) => {
      const result = migrateCleanroom({ root: options.root ?? process.cwd(), dryRun: options.dryRun, json: options.json, legacyCli: options.legacyCli });
      if (result.stdout.length > 0) process.stdout.write(result.stdout);
      if (result.stderr.length > 0) process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    });
}
