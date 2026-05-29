<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&height=250&color=0:fef08a,35:bef264,70:fb923c,100:ec4899&text=SHIPGATE&fontColor=ffffff&fontSize=72&fontAlignY=35&desc=by%20AVANT%20ICONIC&descSize=15&descAlignY=52&animation=scaleIn" alt="ShipGate header" width="100%" />

<br />

<img src="https://readme-typing-svg.demolab.com?font=Inter&weight=600&size=22&pause=1200&color=FB7185&center=true&vCenter=true&width=980&lines=Local-first+verification+gate+for+AI-built+projects.;Fresh+installs.+Real+commands.+Smoke+flows.+Repair+prompts.;Stop+accepting+agent+claims.+Verify+the+project." alt="Typing SVG" />

<br />
<br />

<p align="center">
  <a href="#overview"><img src="https://img.shields.io/badge/overview-111827?style=for-the-badge&logo=readme&logoColor=white" alt="Overview" /></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/quick%20start-f97316?style=for-the-badge&logo=rocket&logoColor=white" alt="Quick Start" /></a>
  <a href="#configuration"><img src="https://img.shields.io/badge/configuration-f43f5e?style=for-the-badge&logo=json&logoColor=white" alt="Configuration" /></a>
  <a href="#commands"><img src="https://img.shields.io/badge/commands-ec4899?style=for-the-badge&logo=terminal&logoColor=white" alt="Commands" /></a>
  <a href="#reports-and-artifacts"><img src="https://img.shields.io/badge/reports-be185d?style=for-the-badge&logo=bookstack&logoColor=white" alt="Reports" /></a>
  <a href="#ci"><img src="https://img.shields.io/badge/CI-c2410c?style=for-the-badge&logo=githubactions&logoColor=white" alt="CI" /></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-9f1239?style=for-the-badge&logo=opensourceinitiative&logoColor=white" alt="License" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7+-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Playwright-browser%20flows-45ba4b?style=flat-square&logo=playwright&logoColor=white" alt="Playwright" />
  <img src="https://img.shields.io/badge/License-AGPL--3.0--or--later-f97316?style=flat-square&logo=opensourceinitiative&logoColor=white" alt="AGPL-3.0-or-later" />
  <img src="https://img.shields.io/github/v/release/AVANT-ICONIC/shipgate-cli?include_prereleases&color=ec4899&style=flat-square" alt="release" />
</p>

<p align="center">
  <strong>Acceptance verification for projects built with coding agents.</strong><br />
  Fresh copy. Clean install. Real commands. Browser/API/CLI/file smoke flows. Reports and repair prompts.
</p>

<p align="center">
  <a href="./docs/CONFIGURATION.md">Configuration</a>
  |
  <a href="./docs/CI.md">CI</a>
  |
  <a href="./examples/ci">CI Examples</a>
  |
  <a href="./CHANGELOG.md">Changelog</a>
  |
  <a href="./TODO.md">Roadmap</a>
</p>

</div>

## Contents

- [Overview](#overview)
- [Category Focus](#category-focus)
- [Why ShipGate?](#why-shipgate)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Commands](#commands)
- [Fresh Verification](#fresh-verification)
- [Reports And Artifacts](#reports-and-artifacts)
- [CI](#ci)
- [MCP Server](#mcp-server)
- [Discovery Prototype](#discovery-prototype)
- [Maintainer Verification](#maintainer-verification)
- [License](#license)

## Category Focus

- **ShipGate = verification gate** - It checks whether a project really installs,
  builds, runs, and passes declared smoke flows from a clean state.
- **Not ShipGate = hosted CI replacement** - It does not replace your test suite,
  product judgment, or deployment pipeline.

---

## Overview

ShipGate is a **local-first verification gate** for AI-built software projects.

It answers the practical question that matters after a coding agent says it is
done: does the project actually work from a clean state?

```txt
agent builds project
        |
shipgate verify --fresh
        |
PASS or FAIL with reports, logs, artifacts, and a repair prompt
```

ShipGate verifies from the outside:

- copies the project to a clean temporary workspace in fresh mode
- installs dependencies from the lockfile
- runs configured typecheck, lint, test, build, and custom commands
- starts the app when browser or API flows need it
- checks browser, API, CLI, and file smoke flows
- captures command logs, browser screenshots, traces, console errors, page errors,
  and app network failures
- writes a markdown report and JSON result
- writes a repair prompt when verification fails

---

## Why ShipGate?

| Problem | Without ShipGate | With ShipGate |
| :--- | :--- | :--- |
| Agent says "done" | Trust chat output | Run `shipgate verify --fresh` |
| Hidden local state | Stale `node_modules`, generated files, local env leakage | Clean temp copy and fresh install |
| Broken app startup | Found late by a human | Managed start process plus readiness checks |
| Weak smoke coverage | Manual clicking or vague screenshots | Named browser, API, CLI, and file flows |
| Failed verification | Long chat archaeology | Report plus repair prompt |
| CI mismatch | Different local and CI rituals | Same verification command everywhere |

ShipGate is intentionally boring at the boundary: the project declares what must
work, and ShipGate checks that reality agrees.

---

## Quick Start

> **Tester release available now.** npm publishing is not required for this path.

Install the current GitHub Release tarball globally:

```bash
npm install -g https://github.com/AVANT-ICONIC/shipgate-cli/releases/download/v0.1.1/shipgate-cli-0.1.1.tgz
shipgate doctor
```

Use it in a project:

```bash
cd your-project
shipgate init --profile vite
shipgate verify --fresh
```

Project-local install also works:

```bash
npm install -D https://github.com/AVANT-ICONIC/shipgate-cli/releases/download/v0.1.1/shipgate-cli-0.1.1.tgz
npx shipgate verify --fresh
```

Update intentionally when a new tester release is available:

```bash
shipgate update
shipgate update --yes
```

The release also includes a transparent installer wrapper:

```bash
curl -fsSL https://github.com/AVANT-ICONIC/shipgate-cli/releases/download/v0.1.1/install.sh | sh
```

Once the package is published to npm, the normal install path will be:

```bash
pnpm add -D @shipgate/cli
pnpm exec shipgate init --profile vite
pnpm exec shipgate verify --fresh
```

From this source repository:

```bash
pnpm install
pnpm build
node dist/cli.js --help
```

---

## Configuration

ShipGate reads `shipgate.config.ts`, `shipgate.config.mts`,
`shipgate.config.js`, `shipgate.config.mjs`, `shipgate.config.cjs`, or
`shipgate.config.json`.

```ts
import { defineShipGateConfig } from "@shipgate/cli";

export default defineShipGateConfig({
  profile: "vite",
  packageManager: "pnpm",
  commands: {
    install: "pnpm install --frozen-lockfile",
    typecheck: "pnpm typecheck",
    lint: "pnpm lint",
    test: "pnpm test",
    build: "pnpm build",
    start: "pnpm preview --host 127.0.0.1 --port 4173"
  },
  app: {
    kind: "browser",
    url: "http://127.0.0.1:4173",
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
        selectorsVisible: ["body"],
        textIncludes: ["Welcome"]
      }
    },
    {
      name: "health endpoint works",
      kind: "api",
      url: "/health",
      expect: {
        status: 200,
        bodyIncludes: ["ok"]
      }
    },
    {
      name: "cli help works",
      kind: "cli",
      command: "node dist/cli.js --help",
      expect: {
        exitCode: 0,
        stdoutIncludes: ["Usage"]
      }
    },
    {
      name: "build artifact exists",
      kind: "file",
      path: "dist/index.js"
    }
  ],
  requiredFiles: ["README.md", "package.json"]
});
```

API flow URLs may be absolute or relative. Relative API URLs resolve against
`app.url`.

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full usage reference.

---

## Commands

| Command | Purpose |
| :--- | :--- |
| `shipgate init` | Create `shipgate.config.ts`, `AGENTS.md`, `VERIFY.md`, and a starter smoke test where useful. |
| `shipgate verify` | Run verification in the current workspace. |
| `shipgate verify --fresh` | Copy the project to a clean temp workspace and verify it there. |
| `shipgate verify --step <name>` | Run only the matching command, hook, or flow plus required-file preflight. |
| `shipgate report` | Print `.shipgate/latest-report.md`. |
| `shipgate report --json` | Print `.shipgate/latest-result.json`. |
| `shipgate explain` | Print a concise diagnosis of the latest result. |
| `shipgate explain --json` | Print the diagnosis as structured JSON. |
| `shipgate repair-prompt` | Print the latest repair prompt from a failed run. |
| `shipgate repair-prompt --copy` | Copy the latest repair prompt to the system clipboard. |
| `shipgate view-report` | Serve the latest report as a local HTML page. |
| `shipgate doctor` | Check local runtime readiness. |
| `shipgate schema` | Print the ShipGate config JSON Schema. |
| `shipgate schema --out shipgate.schema.json` | Write the schema to a file. |
| `shipgate discover` | Prototype helper that drafts weak browser smoke checks from a running app. |
| `shipgate update` | Print or run the command that updates a GitHub-release or npm install. |
| `shipgate mcp` | Start the stdio MCP server for agent clients. |

---

## Fresh Verification

`shipgate verify --fresh` is the main command.

Fresh mode copies the workspace to a temp directory, excludes local junk and
ShipGate's own previous outputs, runs the configured install command, and
verifies from there. This catches missing lockfiles, uncommitted generated
files, stale `node_modules` assumptions, local cache dependencies, and
environment leakage.

By default ShipGate does not copy `.env` or `.env.*` files.

Config-controlled paths are intentionally constrained. `requiredFiles`, file
flows, artifact directories, and discovery output paths must be relative and
stay inside the project. Command `cwd` may move inside the configured workspace
root for monorepos, but it cannot escape the copied workspace.

---

## Reports And Artifacts

Every verification run writes `.shipgate` output:

```txt
.shipgate/
  latest-report.md
  latest-result.json
  latest-repair-prompt.md
  artifacts/
    <run-id>/
      command-logs/
      screenshots/
      traces/
  reports/
    <run-id>-report.md
```

Use `artifacts.dir`, `artifacts.logs`, `artifacts.screenshots`, and
`artifacts.traces` to move or disable captured artifacts. The report and latest
result stay under `.shipgate` so agents have a stable handoff location.

Successful runs remove stale repair prompts. Failed runs keep enough information
for another person or agent to diagnose the problem without reading chat history.

---

## CI

CI should run the same command used locally:

```bash
shipgate verify --fresh
```

See [docs/CI.md](docs/CI.md) and [examples/ci](examples/ci) for GitHub Actions
and GitLab CI examples that preserve `.shipgate` outputs as artifacts.

---

## MCP Server

`shipgate mcp` starts a stdio MCP server for agent clients.

Available MCP tools:

- `shipgate_verify`
- `shipgate_latest_report`
- `shipgate_repair_prompt`
- `shipgate_config_schema`

---

## Discovery Prototype

`shipgate discover` can inspect a running web app and draft weak Playwright smoke
checks. It crawls bounded same-origin routes, skips destructive-looking controls,
can optionally fill safe form fields without submitting, and can optionally run
axe checks or screenshot baseline comparison.

Discovery output is draft material. Keep real acceptance requirements in
explicit `flows` and project tests.

---

## Maintainer Verification

Before publishing or claiming a change is complete, run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
node dist/cli.js doctor
shipgate verify --fresh
```

The fixture should also pass:

```bash
cd examples/node-cli-basic
node ../../dist/cli.js verify --fresh
```

---

## License

ShipGate CLI is licensed under the GNU Affero General Public License v3.0 or
later. See [LICENSE](LICENSE).

---

<div align="center">

<strong>Built for agents that need evidence, not applause.</strong>

<br />
<br />

<img src="https://capsule-render.vercel.app/api?type=waving&section=footer&height=130&color=0:ec4899,50:fb923c,100:fef08a" alt="ShipGate footer" width="100%" />

</div>
