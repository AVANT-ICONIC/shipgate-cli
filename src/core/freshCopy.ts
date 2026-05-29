import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  ".next",
  ".shipgate",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
  "playwright-report",
  "test-results",
  ".env",
  ".env.*"
];

function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/$/, "");
}

function matchesPattern(rel: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return rel.startsWith(prefix) || rel.includes(`/${prefix}`);
  }

  return rel === pattern ||
    rel.startsWith(`${pattern}/`) ||
    rel.endsWith(`/${pattern}`) ||
    rel.includes(`/${pattern}/`);
}

function shouldExclude(relativePath: string, extraExcludes: string[]): boolean {
  const rel = normalize(relativePath);
  if (!rel) return false;

  const all = [...DEFAULT_EXCLUDES, ...extraExcludes].map(normalize);

  return all.some((pattern) => matchesPattern(rel, pattern));
}

export type FreshCopyResult = {
  tempRoot: string;
  cleanup(): Promise<void>;
};

export async function createFreshCopy(projectRoot: string, extraExcludes: string[] = []): Promise<FreshCopyResult> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "shipgate-"));

  await cp(projectRoot, tempRoot, {
    recursive: true,
    filter: (source) => {
      const relativePath = path.relative(projectRoot, source);
      return !shouldExclude(relativePath, extraExcludes);
    }
  });

  return {
    tempRoot,
    async cleanup() {
      await rm(tempRoot, { recursive: true, force: true });
    }
  };
}

export { DEFAULT_EXCLUDES, shouldExclude };
