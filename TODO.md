# TODO

## Phase 1: Core CLI

- [x] Scaffold TypeScript CLI package
- [x] Add command skeletons
- [x] Add config schema
- [x] Add fresh-copy verification
- [x] Add command runner
- [x] Add report writer
- [x] Add repair prompt writer
- [x] Add basic browser flow runner
- [x] Add optional discovery prototype

## Phase 4: Agent Tooling

All tracked Phase 4 items are complete.

## Public Repository Prep

All tracked public documentation and licensing prep items are complete.

## Adversarial Audit Findings

These issues were found while treating ShipGate as broken and were fixed. They
stay listed here so future work does not lose the audit context.

- [x] CLI flow `stdoutIncludes` and `stderrIncludes` matched against truncated report excerpts instead of full logs.
- [x] Timed-out commands could return a null exit code without a clear timeout diagnostic.
- [x] API checks could hang while reading a response body that never ended.
- [x] App readiness checks could hang while waiting for `readyText` in a response body that never ended.
- [x] Fresh-copy verification still copied `.env.*` secret files.
- [x] Fresh-copy verification still copied stale `.shipgate` outputs.
- [x] Package-manager detection ignored the `packageManager` field in `package.json`.
- [x] Browser flow failures could skip browser and trace cleanup.
- [x] `shipgate verify --step <name>` still ran unrelated flows and did not fail unknown step names.
- [x] Configured local paths could escape the project or workspace through `..` or absolute paths.
- [x] Artifact settings existed in the schema but `artifacts.dir`, `logs`, `screenshots`, and `traces` were not fully honored.
- [x] The README release badge ignored prereleases and rendered `no releases or repo not found`.

## Open Hardening Work

- [ ] Design a guarded exploratory browser mode that can crawl routes and click safe controls/buttons without knowing the target app code.
  - Default to inspect-only/dry-run first.
  - Click only same-origin, visible, enabled, non-destructive controls.
  - Block labels, roles, hrefs, and form actions that look destructive: delete, remove, logout, pay, purchase, submit, reset, revoke, archive, unsubscribe, etc.
  - Reset browser context or app state between click attempts so one click does not poison the rest of the run.
  - Record every candidate, skipped candidate, click attempt, navigation, console error, page error, network failure, and screenshot.
  - Never promote generated clicks directly to trusted tests; generate a review report and let the maintainer accept useful flows explicitly.
- [x] Validate project-local paths for `requiredFiles`, file flows, command `cwd`, and artifact paths; command `cwd` may move only inside the configured workspace root.
- [ ] Stream command output directly to log files instead of buffering all stdout/stderr in memory.
- [ ] Add maximum API response-body capture limits so huge responses cannot consume unbounded memory.
- [x] Make `artifacts.dir`, `artifacts.logs`, `artifacts.screenshots`, and `artifacts.traces` real.
- [ ] Add report-viewer routes for captured logs, screenshots, traces, and JSON artifacts instead of only listing local paths.
- [ ] Tighten config validation and error messages for `app.url`, API flow URLs, browser paths, and duplicate step/flow names.
- [ ] Add a publish/package verification mode that tests the actual npm tarball or git-tracked checkout, not just the current working tree.
- [ ] Add Windows and Linux CI coverage for process-tree shutdown, shell quoting, path normalization, and Playwright behavior.
- [ ] Add end-to-end `shipgate init` tests against minimal npm, pnpm, yarn, bun, Vite, Next, and node-cli demo projects.
- [ ] Add stress fixtures for very large command output, very large HTTP responses, slow server startup, port collisions, and interrupted verification.
- [ ] Decide how strict fresh mode should be about `.gitignore`, untracked files, and generated files that are present locally but absent from a clean clone.
- [ ] Add a dedicated security review for shell execution boundaries, config trust assumptions, and MCP tool exposure.

## Distribution Options

- [ ] Primary path: publish `@shipgate/cli` to npm and document `pnpm dlx @shipgate/cli init`, `npx @shipgate/cli init`, and project-local `pnpm add -D @shipgate/cli`.
- [x] While npm publishing is blocked, create GitHub Releases with the `npm pack` tarball attached, for example `shipgate-cli-0.1.1.tgz`.
- [x] Document install from a GitHub Release tarball URL, for example `npm install -g https://github.com/AVANT-ICONIC/shipgate-cli/releases/download/v0.1.1/shipgate-cli-0.1.1.tgz`.
- [x] Add a release script that runs `shipgate verify --fresh`, `npm pack --dry-run`, `npm pack`, checksum generation, and `gh release create`.
- [x] Add a small `install.sh` for GitHub releases that downloads the selected `.tgz` and installs it with the user's package manager; keep it transparent and inspectable.
- [ ] Use npm dist-tags for channels: `latest` for stable, `next` for beta, and optionally `canary` for short-lived test builds.
- [x] Add GitHub Releases with changelog, checksums, and copy-paste install commands while npm publishing is unavailable.
- [x] Add a tiny install script only as a convenience wrapper around npm, not as the source of truth.
- [ ] Add Homebrew tap support after the npm package proves useful; this helps macOS/Linux users who prefer global CLI installs.
- [ ] Consider a Docker image for CI usage, but keep it secondary because local verification needs direct access to the project filesystem and browser dependencies.
- [ ] Consider standalone binaries later; Playwright and package-manager integration make this more complex than a normal single-file CLI.
- [ ] Create one or two public demo repos that intentionally fail, then show how ShipGate reports and repair prompts guide the fix.

## Update Strategy

- [ ] Do not silently auto-update on CLI startup; verification tools should be reproducible and should not execute newly downloaded code without user intent.
- [x] Add `shipgate update` as an explicit command that detects the install scope and prints/runs the right update command.
- [ ] Add a passive update notice for interactive commands only, cached for 24 hours, disabled in CI, and opt-out via `SHIPGATE_NO_UPDATE_CHECK=1`.
- [ ] Never perform network update checks during `shipgate verify --fresh` unless the user explicitly opts in.
- [ ] Support pinned beta testing with `@shipgate/cli@next` or `@shipgate/cli@canary` instead of forcing everyone forward.
- [ ] Document the recommended tester flow: install a specific version, run `shipgate init`, run `shipgate verify --fresh`, then upgrade intentionally when asked.
