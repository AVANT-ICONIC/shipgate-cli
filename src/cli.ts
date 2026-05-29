#!/usr/bin/env node
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

const program = new Command();

program
  .name("shipgate")
  .description("A local-first verification gate for AI-built projects.")
  .version("0.1.1");

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
