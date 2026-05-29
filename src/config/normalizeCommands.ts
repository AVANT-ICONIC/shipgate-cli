import type { CommandConfig, CommandStepConfig } from "./schema.js";

const ORDER: Array<keyof Omit<CommandConfig, "custom">> = [
  "install",
  "typecheck",
  "lint",
  "test",
  "build"
];

function normalizeOne(key: string, value: string | CommandStepConfig | undefined): CommandStepConfig | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    return {
      name: key,
      command: value,
      required: true
    };
  }
  return value;
}

export function normalizeVerificationCommands(commands: CommandConfig): CommandStepConfig[] {
  const result: CommandStepConfig[] = [];

  for (const key of ORDER) {
    const step = normalizeOne(key, commands[key]);
    if (step) result.push(step);
  }

  for (const custom of commands.custom ?? []) {
    result.push(custom);
  }

  return result;
}

export function normalizeStartCommand(commands: CommandConfig): CommandStepConfig | undefined {
  return normalizeOne("start", commands.start);
}
