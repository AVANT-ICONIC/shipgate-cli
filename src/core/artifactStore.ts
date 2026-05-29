import { mkdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { safeTimestamp } from "../utils/time.js";
import type { ArtifactRef } from "../config/schema.js";

export type ArtifactStore = {
  runId: string;
  root: string;
  reportsDir: string;
  artifactsDir: string;
  commandLogsDir: string;
  screenshotsDir: string;
  tracesDir: string;
  writeText(kind: ArtifactRef["kind"], label: string, relPath: string, content: string): Promise<ArtifactRef>;
  copy(kind: ArtifactRef["kind"], label: string, from: string, relPath: string): Promise<ArtifactRef>;
};

export async function createArtifactStore(projectRoot: string, runId = safeTimestamp()): Promise<ArtifactStore> {
  const shipgateRoot = path.join(projectRoot, ".shipgate");
  const reportsDir = path.join(shipgateRoot, "reports");
  const artifactsDir = path.join(shipgateRoot, "artifacts", runId);
  const commandLogsDir = path.join(artifactsDir, "command-logs");
  const screenshotsDir = path.join(artifactsDir, "screenshots");
  const tracesDir = path.join(artifactsDir, "traces");

  await Promise.all([
    mkdir(reportsDir, { recursive: true }),
    mkdir(commandLogsDir, { recursive: true }),
    mkdir(screenshotsDir, { recursive: true }),
    mkdir(tracesDir, { recursive: true })
  ]);

  return {
    runId,
    root: shipgateRoot,
    reportsDir,
    artifactsDir,
    commandLogsDir,
    screenshotsDir,
    tracesDir,
    async writeText(kind, label, relPath, content) {
      const fullPath = path.join(artifactsDir, relPath);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf8");
      return { kind, label, path: fullPath };
    },
    async copy(kind, label, from, relPath) {
      const fullPath = path.join(artifactsDir, relPath);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await copyFile(from, fullPath);
      return { kind, label, path: fullPath };
    }
  };
}
