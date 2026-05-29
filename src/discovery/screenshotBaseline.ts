import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import type { DiscoveredRoute } from "./routeCrawler.js";

export type DiscoveryScreenshotBaselineMode = "off" | "capture" | "compare";

export type ScreenshotComparisonStatus =
  | "captured"
  | "matched"
  | "changed"
  | "missing-baseline";

export type ScreenshotComparison = {
  route: string;
  routePath: string;
  status: ScreenshotComparisonStatus;
  baselinePath: string;
  currentPath?: string;
  baselineHash?: string;
  currentHash?: string;
};

type ScreenshotPage = Pick<Page, "goto" | "screenshot">;

export type RunScreenshotBaselineOptions = {
  projectRoot: string;
  screenshotDir: string;
  mode: DiscoveryScreenshotBaselineMode;
};

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function hashFile(filePath: string): Promise<string> {
  return hashBuffer(await readFile(filePath));
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function routeLabel(route: DiscoveredRoute): string {
  const raw = route.path || new URL(route.url).pathname || "/";
  const normalized = raw === "/" ? "root" : raw.replace(/^\/+/, "");
  const safe = normalized
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return safe || "route";
}

export function screenshotFileName(route: DiscoveredRoute): string {
  return `${routeLabel(route)}-${shortHash(route.url)}.png`;
}

function resolveScreenshotRoot(projectRoot: string, screenshotDir: string): string {
  return path.isAbsolute(screenshotDir)
    ? screenshotDir
    : path.join(projectRoot, screenshotDir);
}

export async function runScreenshotBaseline(
  page: ScreenshotPage,
  routes: DiscoveredRoute[],
  options: RunScreenshotBaselineOptions
): Promise<ScreenshotComparison[]> {
  if (options.mode === "off") return [];

  const root = resolveScreenshotRoot(options.projectRoot, options.screenshotDir);
  const baselineDir = path.join(root, "baseline");
  const currentDir = path.join(root, "latest");
  const comparisons: ScreenshotComparison[] = [];

  await mkdir(baselineDir, { recursive: true });
  if (options.mode === "compare") {
    await mkdir(currentDir, { recursive: true });
  }

  for (const route of routes) {
    const fileName = screenshotFileName(route);
    const baselinePath = path.join(baselineDir, fileName);
    const currentPath = path.join(currentDir, fileName);

    await page.goto(route.url, { waitUntil: "domcontentloaded", timeout: 30000 });

    if (options.mode === "capture") {
      await page.screenshot({ path: baselinePath, fullPage: true });
      comparisons.push({
        route: route.url,
        routePath: route.path,
        status: "captured",
        baselinePath,
        baselineHash: await hashFile(baselinePath)
      });
      continue;
    }

    await page.screenshot({ path: currentPath, fullPage: true });
    const currentHash = await hashFile(currentPath);

    if (!existsSync(baselinePath)) {
      comparisons.push({
        route: route.url,
        routePath: route.path,
        status: "missing-baseline",
        baselinePath,
        currentPath,
        currentHash
      });
      continue;
    }

    const baselineHash = await hashFile(baselinePath);
    comparisons.push({
      route: route.url,
      routePath: route.path,
      status: baselineHash === currentHash ? "matched" : "changed",
      baselinePath,
      currentPath,
      baselineHash,
      currentHash
    });
  }

  return comparisons;
}
