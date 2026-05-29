import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { copyToClipboard } from "../utils/clipboard.js";

export type RepairPromptOptions = {
  copy?: boolean;
};

export type RepairPromptDependencies = {
  projectRoot?: string;
  copyText?: (text: string) => Promise<void>;
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
};

export async function runRepairPromptCommand(
  options: RepairPromptOptions,
  dependencies: RepairPromptDependencies = {}
): Promise<number> {
  const projectRoot = dependencies.projectRoot ?? process.cwd();
  const writeOut = dependencies.writeOut ?? ((text) => process.stdout.write(text));
  const writeErr = dependencies.writeErr ?? ((text) => process.stderr.write(text));
  const file = path.join(projectRoot, ".shipgate", "latest-repair-prompt.md");

  if (!existsSync(file)) {
    writeErr("No ShipGate repair prompt found. Run a failing shipgate verify first.\n");
    return 2;
  }

  const content = readFileSync(file, "utf8");

  if (!options.copy) {
    writeOut(content);
    return 0;
  }

  try {
    if (dependencies.copyText) {
      await dependencies.copyText(content);
    } else {
      await copyToClipboard(content);
    }
    writeErr("Copied ShipGate repair prompt to clipboard.\n");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeErr(`${message}\n`);
    return 2;
  }
}

export function registerRepairPromptCommand(program: Command): void {
  program
    .command("repair-prompt")
    .description("Print the latest ShipGate repair prompt.")
    .option("--copy", "Copy the latest repair prompt to the system clipboard instead of printing.", false)
    .action(async (options: RepairPromptOptions) => {
      process.exitCode = await runRepairPromptCommand(options);
    });
}
