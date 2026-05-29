import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  handleConfigSchemaTool,
  handleLatestReportTool,
  handleRepairPromptTool,
  handleVerifyTool
} from "./tools.js";

export function createShipGateMcpServer(): McpServer {
  const server = new McpServer({
    name: "shipgate",
    version: "0.1.0"
  });

  server.registerTool(
    "shipgate_verify",
    {
      title: "Run ShipGate Verification",
      description: "Run ShipGate verification for a project. Defaults to fresh mode.",
      inputSchema: {
        projectRoot: z.string().optional(),
        config: z.string().optional(),
        fresh: z.boolean().optional(),
        keepTemp: z.boolean().optional(),
        noBrowser: z.boolean().optional(),
        step: z.string().optional()
      }
    },
    (input) => handleVerifyTool(input)
  );

  server.registerTool(
    "shipgate_latest_report",
    {
      title: "Read Latest ShipGate Report",
      description: "Read .shipgate/latest-report.md, or .shipgate/latest-result.json when json is true.",
      inputSchema: {
        projectRoot: z.string().optional(),
        json: z.boolean().optional()
      }
    },
    (input) => handleLatestReportTool(input)
  );

  server.registerTool(
    "shipgate_repair_prompt",
    {
      title: "Read Latest ShipGate Repair Prompt",
      description: "Read .shipgate/latest-repair-prompt.md from the project.",
      inputSchema: {
        projectRoot: z.string().optional()
      }
    },
    (input) => handleRepairPromptTool(input)
  );

  server.registerTool(
    "shipgate_config_schema",
    {
      title: "Read ShipGate Config Schema",
      description: "Return the ShipGate configuration JSON Schema."
    },
    () => handleConfigSchemaTool()
  );

  return server;
}

export async function startShipGateMcpServer(): Promise<void> {
  const server = createShipGateMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
