import type { Command } from "commander";
import { startShipGateMcpServer } from "../mcp/server.js";

export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description("Start the ShipGate MCP stdio server.")
    .action(async () => {
      await startShipGateMcpServer();
    });
}
