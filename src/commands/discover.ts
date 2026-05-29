import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../config/loadConfig.js";
import {
  crawlRoutes,
  isUnsafeDiscoveryCandidate,
  makeSafeFormInteractions,
  type RouteCrawlResult,
  type DiscoveryFormMode,
  type DiscoveredElement,
  type DiscoveredRoute
} from "../discovery/routeCrawler.js";
import { makeDiscoveryReviewReport } from "../discovery/reviewReport.js";
import {
  runScreenshotBaseline,
  type DiscoveryScreenshotBaselineMode,
  type ScreenshotComparison
} from "../discovery/screenshotBaseline.js";
import { logger } from "../utils/logger.js";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function routePath(url: string, baseUrl: string): string {
  const route = new URL(url);
  const base = new URL(baseUrl);
  return route.origin === base.origin ? `${route.pathname}${route.search}` : url;
}

function clickRole(element: DiscoveredElement): "button" | "link" | null {
  if (element.tag === "a") return "link";
  if (element.tag === "button" || element.role === "button") return "button";
  return null;
}

export function makeDiscoverySpec(
  url: string,
  routes: DiscoveredRoute[],
  denyPatterns: string[],
  formMode: DiscoveryFormMode = "inspect"
): string {
  const routePaths = routes.map((route) => routePath(route.url, url));
  const routeChecks = routePaths.map((discoveredPath) => `  await test.step(${JSON.stringify(`route: ${discoveredPath}`)}, async () => {
    await page.goto(new URL(${JSON.stringify(discoveredPath)}, baseUrl).toString());
    await expect(page.locator("body")).toBeVisible();
  });`).join("\n\n");

  const safeClicks = routes
    .flatMap((route) => route.elements.map((element) => ({
      routePath: routePath(route.url, url),
      element,
      role: clickRole(element)
    })))
    .filter((candidate): candidate is { routePath: string; element: DiscoveredElement; role: "button" | "link" } => candidate.role !== null)
    .filter((candidate) => candidate.element.text.trim().length > 0)
    .filter((candidate) => !isUnsafeDiscoveryCandidate(candidate.element, denyPatterns))
    .slice(0, 25);
  const formInteractions = makeSafeFormInteractions(routes, denyPatterns, formMode);

  const clicks = safeClicks.map((candidate, index) => {
    const label = `${candidate.role} ${index + 1}: ${candidate.element.text.slice(0, 60)}`;
    const namePattern = escapeRegex(candidate.element.text.slice(0, 40));
    return `  await test.step(${JSON.stringify(label)}, async () => {
    await page.goto(new URL(${JSON.stringify(candidate.routePath)}, baseUrl).toString());
    await page.getByRole(${JSON.stringify(candidate.role)}, { name: new RegExp(${JSON.stringify(namePattern)}, "i") }).first().click({ timeout: 5000 }).catch(() => {});
    await expect(page.locator("body")).toBeVisible();
  });`;
  }).join("\n\n");

  const forms = formInteractions.map((interaction, index) => {
    const route = routePath(interaction.route, url);
    const label = `form ${index + 1}: ${interaction.label.slice(0, 60)}`;

    if (interaction.action === "select") {
      return `  await test.step(${JSON.stringify(label)}, async () => {
    await page.goto(new URL(${JSON.stringify(route)}, baseUrl).toString());
    await page.locator(${JSON.stringify(interaction.selector)}).first().selectOption({ index: 1 }).catch(() => {});
    await expect(page.locator("body")).toBeVisible();
  });`;
    }

    return `  await test.step(${JSON.stringify(label)}, async () => {
    await page.goto(new URL(${JSON.stringify(route)}, baseUrl).toString());
    await page.locator(${JSON.stringify(interaction.selector)}).first().fill(${JSON.stringify(interaction.value)}).catch(() => {});
    await expect(page.locator("body")).toBeVisible();
  });`;
  }).join("\n\n");

  const importLine = formMode === "safe-fill"
    ? "import { test, expect, type Page } from \"@playwright/test\";"
    : "import { test, expect } from \"@playwright/test\";";
  const formSubmitBlocker = formMode === "safe-fill"
    ? `
async function blockFormSubmissions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.addEventListener("submit", (event) => {
      event.preventDefault();
    }, true);
  });
}
`
    : "";
  const setup = formMode === "safe-fill" ? "  await blockFormSubmissions(page);\n\n" : "";

  return `${importLine};

const baseUrl = process.env.SHIPGATE_BASE_URL ?? ${JSON.stringify(url)};
${formSubmitBlocker}

test("generated discovery smoke draft", async ({ page }) => {
  const errors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  page.on("pageerror", (error) => {
    errors.push(error.message);
  });

${setup}
  await page.goto(baseUrl);
  await expect(page.locator("body")).toBeVisible();

${routeChecks || "  // No same-origin routes discovered beyond the entry page."}

${forms || (formMode === "safe-fill" ? "  // No safe form controls discovered for mutation." : "  // Form mutation mode is inspect-only.")}

${clicks || "  // No safe clickable elements discovered."}

  expect(errors).toEqual([]);
});
`;
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function parseFormMode(value: string | undefined, fallback: DiscoveryFormMode): DiscoveryFormMode {
  if (value === undefined) return fallback;
  if (value === "inspect" || value === "safe-fill") return value;
  throw new Error("--form-mode must be one of: inspect, safe-fill.");
}

function parseScreenshotBaselineMode(
  value: string | undefined,
  fallback: DiscoveryScreenshotBaselineMode
): DiscoveryScreenshotBaselineMode {
  if (value === undefined) return fallback;
  if (value === "off" || value === "capture" || value === "compare") return value;
  throw new Error("--screenshot-baseline must be one of: off, capture, compare.");
}

export function registerDiscoverCommand(program: Command): void {
  program
    .command("discover")
    .description("Prototype: crawl a running app and draft a weak Playwright smoke test.")
    .option("--url <url>", "URL to crawl. Defaults to config app.url.")
    .option("--config <path>", "Path to ShipGate config.")
    .option("--out <path>", "Output Playwright spec path.")
    .option("--max <number>", "Maximum elements to inspect per route.")
    .option("--max-routes <number>", "Maximum same-origin routes to crawl.")
    .option("--form-mode <mode>", "Form handling mode: inspect or safe-fill.")
    .option("--axe", "Run an axe accessibility scan on crawled routes.", false)
    .option("--screenshot-baseline <mode>", "Screenshot baseline mode: off, capture, or compare.")
    .action(async (options: {
      url?: string;
      config?: string;
      out?: string;
      max?: string;
      maxRoutes?: string;
      formMode?: string;
      axe?: boolean;
      screenshotBaseline?: string;
    }) => {
      const projectRoot = process.cwd();
      const loaded = await loadConfig(projectRoot, options.config);
      const url = options.url ?? loaded.config.app?.url;
      if (!url) {
        throw new Error("No URL provided and config.app.url is missing.");
      }

      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const consoleErrors: string[] = [];

      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });

      const maxInteractions = parsePositiveInteger(options.max, loaded.config.discovery.maxInteractions, "--max");
      const maxRoutes = parsePositiveInteger(options.maxRoutes, loaded.config.discovery.maxRoutes, "--max-routes");
      const formMode = parseFormMode(options.formMode, loaded.config.discovery.formMode);
      const accessibilityScan = Boolean(options.axe || loaded.config.discovery.accessibilityScan);
      const screenshotBaselineMode = parseScreenshotBaselineMode(
        options.screenshotBaseline,
        loaded.config.discovery.screenshotBaselineMode
      );
      const { result, screenshotComparisons } = await (async (): Promise<{
        result: RouteCrawlResult;
        screenshotComparisons: ScreenshotComparison[];
      }> => {
        try {
          const crawlResult = await crawlRoutes(page, {
            startUrl: url,
            maxRoutes,
            maxInteractions,
            safeMode: loaded.config.discovery.safeMode,
            denyTextPatterns: loaded.config.discovery.denyTextPatterns,
            accessibilityScan
          });
          const comparisons = await runScreenshotBaseline(page, crawlResult.routes, {
            projectRoot,
            screenshotDir: loaded.config.discovery.screenshotBaselineDir,
            mode: screenshotBaselineMode
          });

          return {
            result: crawlResult,
            screenshotComparisons: comparisons
          };
        } finally {
          await browser.close();
        }
      })();

      const out = options.out ?? loaded.config.discovery.outputSpec;
      const outPath = path.isAbsolute(out) ? out : path.join(projectRoot, out);
      const formInteractions = makeSafeFormInteractions(result.routes, loaded.config.discovery.denyTextPatterns, formMode);
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, makeDiscoverySpec(result.startUrl, result.routes, loaded.config.discovery.denyTextPatterns, formMode), "utf8");

      const reportPath = path.join(projectRoot, ".shipgate", "latest-discovery.json");
      const reviewReportPath = path.join(projectRoot, ".shipgate", "latest-discovery-review.md");
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify({
        url: result.startUrl,
        generatedSpec: outPath,
        reviewReport: reviewReportPath,
        maxRoutes,
        maxInteractions,
        formMode,
        accessibilityScan,
        screenshotBaselineMode,
        screenshotBaselineDir: path.isAbsolute(loaded.config.discovery.screenshotBaselineDir)
          ? loaded.config.discovery.screenshotBaselineDir
          : path.join(projectRoot, loaded.config.discovery.screenshotBaselineDir),
        crawledRoutes: result.routes.map((route) => ({
          url: route.url,
          path: route.path,
          title: route.title,
          status: route.status,
          links: route.links,
          elementCount: route.elements.length,
          unsafeCandidateCount: route.unsafeCandidates.length,
          accessibilityViolationCount: route.accessibilityViolations.length
        })),
        inspectedElements: result.inspectedElements,
        unsafeCandidates: result.unsafeCandidates,
        safeFormInteractions: formInteractions,
        accessibilityViolations: result.accessibilityViolations,
        screenshotComparisons,
        consoleErrors,
        warning: "Discovery output is weak smoke coverage. It proves crash resistance, not business correctness."
      }, null, 2), "utf8");
      await writeFile(reviewReportPath, makeDiscoveryReviewReport({
        projectRoot,
        url: result.startUrl,
        generatedSpec: outPath,
        discoveryJson: reportPath,
        reviewReport: reviewReportPath,
        maxRoutes,
        maxInteractions,
        formMode,
        accessibilityScan,
        screenshotBaselineMode,
        routes: result.routes,
        inspectedElementCount: result.inspectedElements.length,
        unsafeCandidates: result.unsafeCandidates,
        safeFormInteractions: formInteractions,
        accessibilityViolations: result.accessibilityViolations,
        screenshotComparisons,
        consoleErrors
      }), "utf8");

      logger.success("Discovery draft generated.");
      logger.info(`Spec: ${outPath}`);
      logger.info(`Discovery report: ${reportPath}`);
      logger.info(`Review report: ${reviewReportPath}`);
      if (consoleErrors.length) {
        logger.warn(`${consoleErrors.length} console error(s) observed during discovery.`);
      }
      if (result.unsafeCandidates.length) {
        logger.warn(`${result.unsafeCandidates.length} unsafe candidate(s) skipped during discovery.`);
      }
      if (result.accessibilityViolations.length) {
        logger.warn(`${result.accessibilityViolations.length} accessibility violation(s) observed during discovery.`);
      }
      if (screenshotComparisons.length) {
        const changed = screenshotComparisons.filter((comparison) => comparison.status === "changed").length;
        const missing = screenshotComparisons.filter((comparison) => comparison.status === "missing-baseline").length;
        if (changed || missing) {
          logger.warn(`${changed} changed screenshot(s), ${missing} missing baseline(s) observed during discovery.`);
        }
      }
    });
}
