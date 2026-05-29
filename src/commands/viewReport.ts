import type { Command } from "commander";
import { startReportViewer } from "../core/reportViewer.js";

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

export function registerViewReportCommand(program: Command): void {
  program
    .command("view-report")
    .description("Serve the latest ShipGate report in a local web viewer.")
    .option("--host <host>", "Host to bind.", "127.0.0.1")
    .option("--port <port>", "Port to bind. Use 0 for a random available port.", parsePort, 0)
    .action(async (options: { host: string; port: number }) => {
      try {
        const viewer = await startReportViewer({
          projectRoot: process.cwd(),
          host: options.host,
          port: options.port
        });
        process.stdout.write(`ShipGate report viewer: ${viewer.url}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exitCode = 2;
      }
    });
}
