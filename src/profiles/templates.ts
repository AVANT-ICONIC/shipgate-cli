import type { ProjectProfile } from "../config/detectProject.js";
import { pmInstall, pmRun } from "../config/detectProject.js";

function quote(value: string): string {
  return JSON.stringify(value);
}

export function makeConfigTemplate(profile: ProjectProfile, pm: string): string {
  const install = pmInstall(pm);
  const run = (script: string) => pmRun(pm, script);

  if (profile === "node-cli") {
    return `import { defineShipGateConfig } from "@shipgate/cli";

export default defineShipGateConfig({
  profile: "node-cli",
  packageManager: ${quote(pm)},
  commands: {
    install: ${quote(install)},
    typecheck: ${quote(run("typecheck"))},
    lint: ${quote(run("lint"))},
    test: ${quote(run("test"))},
    build: ${quote(run("build"))}
  },
  flows: [
    {
      name: "cli help works",
      kind: "cli",
      command: "node dist/cli.js --help",
      expect: {
        exitCode: 0,
        stdoutIncludes: ["Usage"]
      }
    }
  ],
  requiredFiles: ["README.md", "package.json"],
  discovery: {
    enabled: false
  }
});
`;
  }

  const port = profile === "vite" || profile === "react" ? 4173 : 3000;
  const start = profile === "vite" || profile === "react"
    ? `${run("preview")} --host 127.0.0.1 --port ${port}`
    : run("start");

  return `import { defineShipGateConfig } from "@shipgate/cli";

export default defineShipGateConfig({
  profile: ${quote(profile)},
  packageManager: ${quote(pm)},
  commands: {
    install: ${quote(install)},
    typecheck: ${quote(run("typecheck"))},
    lint: ${quote(run("lint"))},
    test: ${quote(run("test"))},
    build: ${quote(run("build"))},
    start: ${quote(start)}
  },
  app: {
    kind: "browser",
    url: "http://127.0.0.1:${port}",
    startTimeoutMs: 30000,
    readyTimeoutMs: 30000,
    failOnConsoleError: true,
    failOnPageError: true,
    failOnNetworkError: true,
    allowedNetworkFailures: ["*/favicon.ico"]
  },
  flows: [
    {
      name: "homepage loads",
      kind: "browser",
      path: "/",
      expect: {
        selectorsVisible: ["body"]
      }
    }
  ],
  requiredFiles: ["README.md", "package.json"],
  discovery: {
    enabled: false,
    maxRoutes: 10,
    maxInteractions: 25,
    safeMode: true,
    formMode: "inspect",
    accessibilityScan: false,
    screenshotBaselineMode: "off",
    screenshotBaselineDir: ".shipgate/discovery-screenshots",
    outputSpec: "tests/shipgate/generated-discovery.smoke.spec.ts"
  }
});
`;
}

export function makeVerifyMd(): string {
  return `# Verification Protocol

This project is accepted only when this command passes:

    shipgate verify --fresh

Do not claim completion based only on local dev server behavior, partial tests, or non-fresh verification.

## Required Checks

- clean install
- typecheck
- lint if configured
- tests if configured
- production build
- app start if configured
- smoke flows
- no browser console errors
- no page errors
- no unexpected failed app requests

## Reports

Latest report:

    .shipgate/latest-report.md

Latest repair prompt:

    .shipgate/latest-repair-prompt.md
`;
}

export function makeAgentsSection(): string {
  return `

## ShipGate Verification Rule

Before claiming completion, run:

    shipgate verify --fresh

If it fails:

1. Read \`.shipgate/latest-report.md\`.
2. Read \`.shipgate/latest-repair-prompt.md\`.
3. Fix the root cause.
4. Rerun \`shipgate verify --fresh\`.

Do not remove or weaken ShipGate checks to make verification pass unless the user explicitly requests a verification contract change.
`;
}

export function makeSmokeSpec(): string {
  return `import { test, expect } from "@playwright/test";

test("homepage loads without crashing", async ({ page }) => {
  const errors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  page.on("pageerror", (error) => {
    errors.push(error.message);
  });

  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();

  expect(errors).toEqual([]);
});
`;
}
