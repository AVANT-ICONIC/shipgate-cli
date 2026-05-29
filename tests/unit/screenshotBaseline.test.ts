import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  runScreenshotBaseline,
  screenshotFileName,
  type ScreenshotComparison
} from "../../src/discovery/screenshotBaseline.js";
import type { DiscoveredRoute } from "../../src/discovery/routeCrawler.js";

function route(url: string, routePath: string): DiscoveredRoute {
  return {
    url,
    path: routePath,
    title: routePath,
    status: 200,
    links: [],
    elements: [],
    unsafeCandidates: [],
    accessibilityViolations: []
  };
}

function fakePage(screenshots: Record<string, string>) {
  let currentUrl = "";

  return {
    async goto(url: string) {
      currentUrl = url;
      return null;
    },
    async screenshot(options: { path?: string }) {
      if (!options.path) throw new Error("Expected screenshot path.");
      await writeFile(options.path, screenshots[currentUrl] ?? "");
      return Buffer.from(screenshots[currentUrl] ?? "");
    }
  };
}

describe("runScreenshotBaseline", () => {
  it("captures baseline screenshots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shipgate-screenshots-"));
    const routes = [route("https://app.example.test/", "/")];

    const comparisons = await runScreenshotBaseline(fakePage({
      "https://app.example.test/": "baseline"
    }), routes, {
      projectRoot: root,
      screenshotDir: ".shipgate/discovery-screenshots",
      mode: "capture"
    });

    expect(comparisons).toEqual([
      expect.objectContaining({
        route: "https://app.example.test/",
        routePath: "/",
        status: "captured"
      })
    ]);
    const [comparison] = comparisons;
    expect(comparison).toBeDefined();
    if (!comparison) throw new Error("Expected captured comparison.");
    await expect(readFile(comparison.baselinePath, "utf8")).resolves.toBe("baseline");

    await rm(root, { recursive: true, force: true });
  });

  it("compares current screenshots against existing baselines", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shipgate-screenshots-"));
    const routes = [
      route("https://app.example.test/", "/"),
      route("https://app.example.test/settings", "/settings"),
      route("https://app.example.test/reports", "/reports")
    ];
    const baselineDir = path.join(root, ".shipgate/discovery-screenshots/baseline");
    await mkdir(baselineDir, { recursive: true });
    const [homeRoute, settingsRoute] = routes;
    expect(homeRoute).toBeDefined();
    expect(settingsRoute).toBeDefined();
    if (!homeRoute || !settingsRoute) throw new Error("Expected comparison routes.");
    await writeFile(path.join(baselineDir, screenshotFileName(homeRoute)), "same");
    await writeFile(path.join(baselineDir, screenshotFileName(settingsRoute)), "old");

    const comparisons = await runScreenshotBaseline(fakePage({
      "https://app.example.test/": "same",
      "https://app.example.test/settings": "new",
      "https://app.example.test/reports": "new-route"
    }), routes, {
      projectRoot: root,
      screenshotDir: ".shipgate/discovery-screenshots",
      mode: "compare"
    });

    expect(comparisons.map((comparison: ScreenshotComparison) => comparison.status)).toEqual([
      "matched",
      "changed",
      "missing-baseline"
    ]);
    const [, changedComparison, missingComparison] = comparisons;
    expect(changedComparison).toBeDefined();
    expect(missingComparison).toBeDefined();
    if (!changedComparison || !missingComparison) throw new Error("Expected comparison results.");
    expect(changedComparison.baselineHash).not.toBe(changedComparison.currentHash);
    await expect(readFile(missingComparison.currentPath ?? "", "utf8")).resolves.toBe("new-route");

    await rm(root, { recursive: true, force: true });
  });
});
