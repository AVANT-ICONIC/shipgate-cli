import { existsSync } from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { shipGateConfigSchema, type ShipGateConfig } from "./schema.js";

const CONFIG_NAMES = [
  "shipgate.config.ts",
  "shipgate.config.mts",
  "shipgate.config.js",
  "shipgate.config.mjs",
  "shipgate.config.cjs",
  "shipgate.config.json"
];

export type LoadedConfig = {
  path: string;
  dir: string;
  config: ShipGateConfig;
};

export async function findConfig(projectRoot: string, explicitPath?: string): Promise<string | null> {
  if (explicitPath) {
    const fullPath = path.isAbsolute(explicitPath)
      ? explicitPath
      : path.join(projectRoot, explicitPath);
    return existsSync(fullPath) ? fullPath : null;
  }

  for (const name of CONFIG_NAMES) {
    const fullPath = path.join(projectRoot, name);
    if (existsSync(fullPath)) return fullPath;
  }

  return null;
}

export async function loadConfig(projectRoot: string, explicitPath?: string): Promise<LoadedConfig> {
  const configPath = await findConfig(projectRoot, explicitPath);

  if (!configPath) {
    throw new Error(
      `No ShipGate config found. Run "shipgate init" or pass --config.`
    );
  }

  const jiti = createJiti(import.meta.url, {
    interopDefault: true
  });

  const imported = await jiti.import(configPath, { default: true });
  const rawConfig = imported && typeof imported === "object" && "default" in imported
    ? (imported as { default: unknown }).default
    : imported;

  const parsed = shipGateConfigSchema.safeParse(rawConfig);

  if (!parsed.success) {
    throw new Error(`Invalid ShipGate config at ${configPath}:\n${parsed.error.message}`);
  }

  return {
    path: configPath,
    dir: path.dirname(configPath),
    config: parsed.data
  };
}
