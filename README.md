# ShipGate CLI

ShipGate is a local-first verification gate for AI-built software projects.

It answers the practical question that matters after a coding agent says it is
done: does the project actually install, build, run, and pass its declared smoke
checks from a clean state?

```txt
agent builds project
        |
shipgate verify --fresh
        |
PASS or FAIL with reports, logs, artifacts, and a repair prompt
```

## What It Does

ShipGate verifies a project from the outside:

- copies the project to a clean temporary workspace in fresh mode
- installs dependencies from the lockfile
- runs configured typecheck, lint, test, build, and custom commands
- starts the app when browser or API flows need it
- checks browser, API, CLI, and file smoke flows
- captures command logs, browser screenshots, traces, console errors, page errors,
  and app network failures
- writes a markdown report and JSON result
- writes a repair prompt when verification fails

ShipGate is not a hosted service, a full CI replacement, a coverage tool, or a
test generator that can understand product intent. It is an acceptance gate: the
project declares what must work, and ShipGate checks that reality agrees.

## Install

Use it as a dev dependency in the project you want to verify:

```bash
pnpm add -D @shipgate/cli
pnpm exec shipgate init --profile vite
pnpm exec shipgate verify --fresh
```

Other package managers work too:

```bash
npm install --save-dev @shipgate/cli
npx shipgate verify --fresh
```

From this source repository:

```bash
pnpm install
pnpm build
node dist/cli.js --help
```

## Basic Workflow

Initialize a project:

```bash
shipgate init --profile vite
```

Edit `shipgate.config.ts` so it reflects the real project contract.

Run the gate:

```bash
shipgate verify --fresh
```

Inspect the latest result:

```bash
shipgate report
shipgate explain
shipgate view-report
```

If the run failed, hand the generated prompt to the next repair agent:

```bash
shipgate repair-prompt
shipgate repair-prompt --copy
```

## Configuration

ShipGate uses `shipgate.config.ts`.

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

## Commands

| Command | Purpose |
| --- | --- |
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
| `shipgate mcp` | Start the stdio MCP server for agent clients. |

## Fresh Verification

`shipgate verify --fresh` is the main command.

Fresh mode copies the workspace to a temp directory, excludes local junk and
ShipGate's own previous outputs, runs the configured install command, and
verifies from there. This catches missing lockfiles, uncommitted generated
files, stale `node_modules` assumptions, local cache dependencies, and
environment leakage.

By default ShipGate does not copy `.env` or `.env.*` files.

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

Successful runs remove stale repair prompts. Failed runs keep enough information
for another person or agent to diagnose the problem without reading chat history.

## CI

CI should run the same command used locally:

```bash
shipgate verify --fresh
```

See [docs/CI.md](docs/CI.md) and [examples/ci](examples/ci) for GitHub Actions
and GitLab CI examples that preserve `.shipgate` outputs as artifacts.

## MCP Server

`shipgate mcp` starts a stdio MCP server for agent clients.

Available MCP tools:

- `shipgate_verify`
- `shipgate_latest_report`
- `shipgate_repair_prompt`
- `shipgate_config_schema`

## Discovery Prototype

`shipgate discover` can inspect a running web app and draft weak Playwright smoke
checks. It crawls bounded same-origin routes, skips destructive-looking controls,
can optionally fill safe form fields without submitting, and can optionally run
axe checks or screenshot baseline comparison.

Discovery output is draft material. Keep real acceptance requirements in
explicit `flows` and project tests.

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

## License

ShipGate CLI is licensed under the GNU Affero General Public License v3.0 or
later. See [LICENSE](LICENSE).
