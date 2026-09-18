#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerVerifyCommand } from "./commands/verify.js";
import { registerReportCommand } from "./commands/report.js";
import { registerExplainCommand } from "./commands/explain.js";
import { registerRepairPromptCommand } from "./commands/repairPrompt.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerDiscoverCommand } from "./commands/discover.js";
import { registerSchemaCommand } from "./commands/schema.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerViewReportCommand } from "./commands/viewReport.js";
import { registerUpdateCommand } from "./commands/update.js";

/**
 * ONE SOURCE OF TRUTH FOR THE VERSION.
 *
 * This was the literal `"0.1.1"`, beside a package.json that said something
 * else. MEASURED 2026-09-18: v0.1.2 was tagged, packed and published, and its
 * `dist/cli.js` still answered 0.1.1 -- the tarball's name and its contents
 * were different builds. apex-nexus's CI caught it only because that workflow
 * asks the installed binary its version rather than checking that a file
 * exists.
 *
 * `../package.json` resolves from `dist/cli.js` to the package root, which is
 * true both in this repository and in an installed copy, because `dist/` sits
 * at the root in both.
 */
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version: string };

const program = new Command();

program
  .name("shipgate")
  .description("A local-first verification gate for AI-built projects.")
  .version(pkg.version);

registerInitCommand(program);
registerVerifyCommand(program);
registerReportCommand(program);
registerExplainCommand(program);
registerRepairPromptCommand(program);
registerDoctorCommand(program);
registerSchemaCommand(program);
registerDiscoverCommand(program);
registerMcpCommand(program);
registerViewReportCommand(program);
registerUpdateCommand(program);

program.parseAsync(process.argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ShipGate failed: ${message}`);
  process.exitCode = 2;
});
