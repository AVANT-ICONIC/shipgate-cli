import { defineShipGateConfig } from "./src/index.js";

export default defineShipGateConfig({
  profile: "node-cli",
  packageManager: "pnpm",
  commands: {
    install: "pnpm install --frozen-lockfile",
    typecheck: "pnpm typecheck",
    lint: "pnpm lint",
    test: "pnpm test",
    build: "pnpm build"
  },
  flows: [
    {
      name: "packaged CLI help works",
      kind: "cli",
      command: "node dist/cli.js --help",
      expect: {
        exitCode: 0,
        stdoutIncludes: ["Usage: shipgate"]
      }
    },
    {
      name: "packaged CLI schema works",
      kind: "cli",
      command: "node dist/cli.js schema",
      expect: {
        exitCode: 0,
        stdoutIncludes: [
          "\"title\": \"ShipGate Configuration\"",
          "\"workspace\"",
          "\"hooks\""
        ]
      }
    }
  ],
  requiredFiles: [
    "README.md",
    "LICENSE",
    "package.json",
    "pnpm-lock.yaml",
    "docs/CONFIGURATION.md",
    "docs/CI.md"
  ]
});
