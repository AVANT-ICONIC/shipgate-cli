import { mkdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { safeTimestamp } from "../utils/time.js";
import { resolveLocalPath } from "../utils/pathSafety.js";
import type { ArtifactRef, ShipGateConfig } from "../config/schema.js";

export type ArtifactStoreConfig = ShipGateConfig["artifacts"];

export type ArtifactStore = {
  runId: string;
  root: string;
  reportsDir: string;
  artifactsDir: string;
  commandLogsDir: string;
  screenshotsDir: string;
  tracesDir: string;
  logsEnabled: boolean;
  screenshotsEnabled: boolean;
  tracesEnabled: boolean;
  writeText(kind: ArtifactRef["kind"], label: string, relPath: string, content: string): Promise<ArtifactRef>;
  copy(kind: ArtifactRef["kind"], label: string, from: string, relPath: string): Promise<ArtifactRef>;
};

export async function createArtifactStore(
  projectRoot: string,
  runId = safeTimestamp(),
  config: ArtifactStoreConfig = {
    dir: ".shipgate/artifacts",
    logs: true,
    screenshots: true,
    traces: true
  }
): Promise<ArtifactStore> {
  const shipgateRoot = path.join(projectRoot, ".shipgate");
  const reportsDir = path.join(shipgateRoot, "reports");
  const artifactRoot = resolveLocalPath(projectRoot, config.dir, "artifacts.dir");
  const artifactsDir = path.join(artifactRoot, runId);
  const commandLogsDir = path.join(artifactsDir, "command-logs");
  const screenshotsDir = path.join(artifactsDir, "screenshots");
  const tracesDir = path.join(artifactsDir, "traces");
  const dirs = [reportsDir, artifactsDir];
  if (config.logs) dirs.push(commandLogsDir);
  if (config.screenshots) dirs.push(screenshotsDir);
  if (config.traces) dirs.push(tracesDir);

  await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));

  return {
    runId,
    root: shipgateRoot,
    reportsDir,
    artifactsDir,
    commandLogsDir,
    screenshotsDir,
    tracesDir,
    logsEnabled: config.logs,
    screenshotsEnabled: config.screenshots,
    tracesEnabled: config.traces,
    async writeText(kind, label, relPath, content) {
      const fullPath = resolveLocalPath(artifactsDir, relPath, "artifact path");
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf8");
      return { kind, label, path: fullPath };
    },
    async copy(kind, label, from, relPath) {
      const fullPath = resolveLocalPath(artifactsDir, relPath, "artifact path");
      await mkdir(path.dirname(fullPath), { recursive: true });
      await copyFile(from, fullPath);
      return { kind, label, path: fullPath };
    }
  };
}
