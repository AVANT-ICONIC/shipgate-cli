# Verification

Use this file when changing this repository itself.

## Local Checks

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
npm pack --dry-run
node dist/cli.js doctor
```

## Fixture Check

```bash
cd examples/node-cli-basic
node ../../dist/cli.js verify --fresh
```

## Final Gate

```bash
shipgate verify --fresh
```

The final gate must pass before a change is called complete.
