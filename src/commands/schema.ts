import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { shipGateJsonSchema } from "../config/jsonSchema.js";
import { logger } from "../utils/logger.js";

function schemaJson(): string {
  return `${JSON.stringify(shipGateJsonSchema, null, 2)}\n`;
}

export function registerSchemaCommand(program: Command): void {
  program
    .command("schema")
    .description("Print the ShipGate config JSON Schema.")
    .option("--out <path>", "Write schema JSON to a file instead of stdout.")
    .action(async (options: { out?: string }) => {
      const content = schemaJson();

      if (!options.out) {
        process.stdout.write(content);
        return;
      }

      const outputPath = path.isAbsolute(options.out)
        ? options.out
        : path.join(process.cwd(), options.out);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, content, "utf8");
      logger.success(`Wrote ShipGate JSON Schema: ${outputPath}`);
    });
}

export { schemaJson };
