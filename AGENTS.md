# Agent Instructions

This repository should be understandable from files on disk. Do not rely on chat
history.

## Project State

ShipGate CLI is a completed local-first verification gate for AI-built projects.
The public usage docs live in:

- `README.md`
- `docs/CONFIGURATION.md`
- `docs/CI.md`
- `examples/ci/`

Open work belongs in `TODO.md`. Completed user-visible changes belong in
`CHANGELOG.md`.

## Verification Rule

Before claiming completion, run:

```bash
shipgate verify --fresh
```

If it fails:

1. Read `.shipgate/latest-report.md`.
2. Read `.shipgate/latest-repair-prompt.md`.
3. Fix the root cause.
4. Rerun `shipgate verify --fresh`.

Do not remove or weaken ShipGate checks to make verification pass unless the
user explicitly requests a verification contract change.

## Local Quality Checks

Use these checks before the final ShipGate gate when code or package metadata
changes:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
npm pack --dry-run
```

Also verify the included fixture when CLI behavior changes:

```bash
cd examples/node-cli-basic
node ../../dist/cli.js verify --fresh
```

## Documentation Policy

Keep documentation public-facing and usage-focused. Avoid adding chat handoff
files, internal roadmap essays, or duplicate product-spec documents. A new agent
should learn the project from `README.md`, `docs/`, `TODO.md`, `CHANGELOG.md`,
and this file.
