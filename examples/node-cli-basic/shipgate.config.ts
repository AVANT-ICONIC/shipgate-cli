import { defineShipGateConfig } from "../../src/index.js";

export default defineShipGateConfig({
  profile: "node-cli",
  packageManager: "npm",
  commands: {
    install: "npm install",
    typecheck: "npm run typecheck",
    lint: "npm run lint",
    test: "npm run test",
    build: "npm run build"
  },
  flows: [
    {
      name: "help command works",
      kind: "cli",
      command: "node dist/cli.js --help",
      expect: {
        exitCode: 0,
        stdoutIncludes: ["Usage"]
      }
    }
  ],
  requiredFiles: ["README.md", "package.json"]
});
