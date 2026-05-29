# ShipGate Configuration

ShipGate reads `shipgate.config.ts`, `shipgate.config.mts`,
`shipgate.config.js`, `shipgate.config.mjs`, `shipgate.config.cjs`, or
`shipgate.config.json` from the project root.

TypeScript configs can use `defineShipGateConfig` for editor support:

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
    build: "pnpm build"
  }
});
```

## Top-Level Options

| Option | Purpose |
| --- | --- |
| `profile` | Descriptive project profile such as `generic`, `vite`, `next`, `react`, or `node-cli`. |
| `packageManager` | `npm`, `pnpm`, `yarn`, `bun`, or `auto`. |
| `workspace` | Monorepo root and package directory settings. |
| `commands` | Install, verification, start, and custom command steps. |
| `hooks` | Command hooks around verification phases. |
| `app` | App URL and browser/API runtime failure policy. |
| `flows` | Browser, API, CLI, and file smoke checks. |
| `requiredFiles` | Files that must exist before commands run. |
| `artifacts` | Artifact output settings. |
| `fresh` | Fresh-copy exclusion and temp retention settings. |
| `failurePolicy` | Stop/fail behavior for command and runtime failures. |
| `discovery` | Optional `shipgate discover` settings. |
| `env` | Environment variables added to managed commands. |

## Command Steps

Command entries can be strings:

```ts
commands: {
  test: "pnpm test"
}
```

Or objects:

```ts
commands: {
  test: {
    name: "unit tests",
    command: "pnpm test",
    timeoutMs: 120000,
    required: true,
    env: {
      CI: "true"
    }
  }
}
```

Built-in verification command order:

1. `install`
2. `typecheck`
3. `lint`
4. `test`
5. `build`
6. `custom`

`start` is used only as a managed app process for browser and API flows.

`cwd` is optional. It is resolved relative to the verified project directory.
For monorepos, it may point anywhere inside `workspace.root`, but it cannot
escape the copied workspace.

## Hooks

Hooks use the same object shape as command steps.

```ts
hooks: {
  beforeVerify: [
    { name: "check env example", command: "node scripts/check-env-example.mjs" }
  ],
  beforeFlows: [
    { name: "seed smoke data", command: "node scripts/seed-smoke-data.mjs" }
  ],
  afterFlows: [
    { name: "collect diagnostics", command: "node scripts/collect-diagnostics.mjs", required: false }
  ],
  afterVerify: [
    { name: "cleanup", command: "node scripts/cleanup.mjs", required: false }
  ]
}
```

Supported phases are `beforeVerify`, `beforeFlows`, `afterFlows`, and
`afterVerify`.

## App Readiness

Configure `app` when browser or API flows need a running server:

```ts
app: {
  kind: "browser",
  url: "http://127.0.0.1:4173",
  readyText: "ready",
  readyTimeoutMs: 30000,
  failOnConsoleError: true,
  failOnPageError: true,
  failOnNetworkError: true,
  allowedNetworkFailures: ["*/favicon.ico"]
}
```

If `readyText` is set, ShipGate waits until `app.url` returns a body containing
that text. If the managed start process exits before readiness, verification
fails and includes the process exit details.

Browser network failures are tracked only for the configured app origin.

## Browser Flows

Browser flows use Playwright Chromium.

```ts
flows: [
  {
    name: "homepage loads",
    kind: "browser",
    path: "/",
    timeoutMs: 30000,
    expect: {
      titleContains: "Acme",
      textIncludes: ["Dashboard"],
      selectorsVisible: ["body", "[data-testid='dashboard']"]
    }
  }
]
```

ShipGate captures screenshots and traces for browser flows unless disabled in
`artifacts`.

## API Flows

API flow URLs may be absolute:

```ts
{
  name: "external health endpoint",
  kind: "api",
  url: "https://api.example.com/health",
  expect: {
    status: 200,
    bodyIncludes: ["ok"]
  }
}
```

Or relative to `app.url`:

```ts
app: {
  kind: "api",
  url: "http://127.0.0.1:3000"
},
flows: [
  {
    name: "local health endpoint",
    kind: "api",
    url: "/health",
    expect: {
      status: 200,
      bodyIncludes: ["ok"]
    }
  }
]
```

## CLI Flows

CLI flows run a command in the verified project directory:

```ts
{
  name: "help output works",
  kind: "cli",
  command: "node dist/cli.js --help",
  expect: {
    exitCode: 0,
    stdoutIncludes: ["Usage"],
    stderrIncludes: []
  }
}
```

Command logs are stored under `.shipgate/artifacts/<run-id>/command-logs`.

## File Flows

File flows verify generated artifacts:

```ts
{
  name: "bundle exists",
  kind: "file",
  path: "dist/index.js",
  expect: {
    exists: true
  }
}
```

Use `exists: false` when a file must not be present.

## Path Policy

Config-controlled local paths must be relative. ShipGate rejects absolute paths,
null bytes, and `..` escapes before running commands.

| Path field | Allowed boundary |
| --- | --- |
| `requiredFiles[]` | Project directory |
| File flow `path` | Project directory |
| `artifacts.dir` | Project directory |
| `discovery.outputSpec` | Project directory |
| `discovery.screenshotBaselineDir` | Project directory |
| Command `cwd` | Configured workspace root |

This keeps `shipgate verify --fresh` honest: commands and file checks run
against the copied workspace, not files outside it.

## Artifacts

Artifact settings control where captured logs, screenshots, and traces are
written:

```ts
artifacts: {
  dir: ".shipgate/artifacts",
  logs: true,
  screenshots: true,
  traces: true
}
```

`dir` is relative to the project directory. Reports, latest result JSON, and
repair prompts stay under `.shipgate` so agents and CI have stable paths.

## Monorepos

For package verification inside a larger workspace, set `workspace.root`.

If the config lives inside the package:

```ts
workspace: {
  root: "../.."
}
```

If the config lives at the workspace root and verifies a package:

```ts
workspace: {
  root: ".",
  projectDir: "packages/web"
}
```

In fresh mode ShipGate copies the workspace root, then runs required-file checks,
commands, hooks, and flows from the project directory.

## Fresh Copy

Fresh mode excludes common local-only paths such as `node_modules`, `.env`,
`.env.*`, build output, and ShipGate's own `.shipgate` output directory. Add
project-specific excludes with:

```ts
fresh: {
  exclude: ["tmp", "coverage"],
  keepTemp: false
}
```

Use `--keep-temp` when debugging a fresh-copy failure.

## JSON Schema

Print the schema:

```bash
shipgate schema
```

Write it to disk:

```bash
shipgate schema --out shipgate.schema.json
```

The schema is also exported from the package:

```ts
import { shipGateJsonSchema } from "@shipgate/cli";
```

## Discovery Settings

`shipgate discover` is optional and never runs as part of `shipgate verify`.

```ts
discovery: {
  enabled: false,
  maxRoutes: 10,
  maxInteractions: 25,
  safeMode: true,
  formMode: "inspect",
  accessibilityScan: false,
  screenshotBaselineMode: "off"
}
```

Generated discovery output is a draft. Promote useful checks into explicit
project tests or named `flows`.
