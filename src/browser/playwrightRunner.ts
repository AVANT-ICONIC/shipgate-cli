import path from "node:path";
import type { Browser, BrowserContext } from "playwright";
import type { BrowserFlow, ShipGateConfig, StepResult } from "../config/schema.js";
import type { ArtifactStore } from "../core/artifactStore.js";
import { durationMs, nowIso } from "../utils/time.js";

function sanitizeName(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
}

function matchesAllowed(url: string, allowed: string[]): boolean {
  return allowed.some((pattern) => {
    if (pattern.includes("*")) {
      const regex = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
      return regex.test(url);
    }
    return url.includes(pattern);
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function shouldTrackNetworkFailure(
  url: string,
  appUrl: string,
  allowedNetworkFailures: string[]
): boolean {
  try {
    const isSameOrigin = new URL(url).origin === new URL(appUrl).origin;
    return isSameOrigin && !matchesAllowed(url, allowedNetworkFailures);
  } catch {
    return false;
  }
}

export async function runBrowserFlow(
  flow: BrowserFlow,
  config: ShipGateConfig,
  cwd: string,
  store: ArtifactStore
): Promise<StepResult> {
  const startedAt = nowIso();
  const start = Date.now();
  const safeName = sanitizeName(flow.name);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const networkFailures: string[] = [];
  const artifacts = [];
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let tracePath: string | undefined;
  let traceStopped = false;

  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    tracePath = path.join(store.tracesDir, `${safeName}.zip`);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

    const page = await context.newPage();
    const baseUrl = config.app?.url ?? "";
    const targetUrl = new URL(flow.path, baseUrl).toString();

    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });

    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });

    page.on("requestfailed", (request) => {
      const failure = request.failure();
      const url = request.url();
      if (shouldTrackNetworkFailure(url, baseUrl, config.app?.allowedNetworkFailures ?? [])) {
        networkFailures.push(`${request.method()} ${url} failed: ${failure?.errorText ?? "unknown"}`);
      }
    });

    page.on("response", (response) => {
      const url = response.url();
      const status = response.status();
      if (status >= 500 && shouldTrackNetworkFailure(url, baseUrl, config.app?.allowedNetworkFailures ?? [])) {
        networkFailures.push(`${response.request().method()} ${url} returned ${status}`);
      }
    });

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: flow.timeoutMs ?? 30000
    });

    const expect = flow.expect ?? { selectorsVisible: ["body"], textIncludes: [] };

    for (const selector of expect.selectorsVisible ?? ["body"]) {
      await page.locator(selector).first().waitFor({ state: "visible", timeout: 10000 });
    }

    if (expect.titleContains) {
      const title = await page.title();
      if (!title.includes(expect.titleContains)) {
        pageErrors.push(`Expected title to contain "${expect.titleContains}", got "${title}"`);
      }
    }

    for (const text of expect.textIncludes ?? []) {
      const locator = page.getByText(text).first();
      await locator.waitFor({ state: "visible", timeout: 10000 });
    }

    const screenshotPath = path.join(store.screenshotsDir, `${safeName}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    artifacts.push({ kind: "screenshot" as const, label: `${flow.name} screenshot`, path: screenshotPath });

    await context.tracing.stop({ path: tracePath });
    traceStopped = true;
    artifacts.push({ kind: "trace" as const, label: `${flow.name} trace`, path: tracePath });

    await browser.close();
    browser = undefined;
    context = undefined;

    const failures: string[] = [];
    if ((config.app?.failOnConsoleError ?? true) && consoleErrors.length) failures.push(...consoleErrors.map((e) => `Console error: ${e}`));
    if ((config.app?.failOnPageError ?? true) && pageErrors.length) failures.push(...pageErrors.map((e) => `Page error: ${e}`));
    if ((config.app?.failOnNetworkError ?? true) && networkFailures.length) failures.push(...networkFailures.map((e) => `Network failure: ${e}`));

    return {
      id: `browser:${flow.name}`,
      name: flow.name,
      kind: "browser",
      status: failures.length ? "failed" : "passed",
      required: true,
      startedAt,
      endedAt: nowIso(),
      durationMs: durationMs(start),
      error: failures.length ? failures.join("\n") : undefined,
      artifacts,
      details: {
        url: targetUrl,
        consoleErrors,
        pageErrors,
        networkFailures
      }
    };
  } catch (error) {
    if (context && !traceStopped) {
      try {
        if (tracePath) {
          await context.tracing.stop({ path: tracePath });
          artifacts.push({ kind: "trace" as const, label: `${flow.name} trace`, path: tracePath });
        } else {
          await context.tracing.stop();
        }
      } catch {
        // The original browser failure is more useful than a cleanup failure.
      }
    }

    if (browser) {
      try {
        await browser.close();
      } catch {
        // Browser may already be gone after a hard Playwright failure.
      }
    }

    return {
      id: `browser:${flow.name}`,
      name: flow.name,
      kind: "browser",
      status: "failed",
      required: true,
      startedAt,
      endedAt: nowIso(),
      durationMs: durationMs(start),
      error: error instanceof Error ? error.message : String(error),
      artifacts
    };
  }
}
