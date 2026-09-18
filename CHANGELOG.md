# Changelog

## Unreleased

No unreleased changes.

## 0.1.2 - 2026-09-18

- A fresh copy of a repository is now still a repository. `.git` was in the
  default excludes, so every check that asks git failed in the fresh copy and
  said only `fatal: not a git repository`. Measured in apex-nexus: 26 of its
  tests failed that way and passed everywhere else. The copy now gets a `.git`
  of a few kilobytes via `git clone --local --shared --no-checkout` plus
  `read-tree`, borrowing the object store rather than copying it, because that
  project's `.git` is 8.7 GB.
- The fresh copy carries the project's remotes and its symlinks as written.
- Installing from a git URL produces a working binary. The package declares a
  `bin` and ships `dist/`, but had no `prepare` script, and `prepare` is the
  only script npm runs for a git dependency. So `dist/` was never built, the bin
  target did not exist, npm skipped the link in silence, and the install exited
  0 with nothing to run.

## 0.1.1 - 2026-05-29

- Added a pnpm lockfile, pinned pnpm version, and runnable ESLint flat configuration for TypeScript source checks.
- Updated Execa process shutdown typing and options so the project typechecks against installed dependencies.
- Corrected `defineShipGateConfig` typing so documented configurations can omit schema-defaulted fields.
- Made configured `lint` and `test` commands required verification steps unless explicitly marked optional.
- Fixed command result capture so reports and logs do not duplicate stdout or stderr.
- Stripped terminal styling from report excerpts while retaining raw command log artifacts.
- Removed stale repair prompts when a subsequent verification passes.
- Fixed packaged CLI execution by removing the duplicate generated shebang.
- Added a self-verification configuration for clean install/build and packaged CLI smoke checks.
- Validated the built CLI and fresh verification of the `node-cli-basic` fixture.
- Added passing and failing fixture integration tests for fresh verification, flow execution, and repair-prompt generation.
- Enforced optional app readiness text and bounded readiness HTTP requests by the configured timeout.
- Failed app readiness immediately when the managed server exits, reporting its exit code and stderr.
- Limited browser network failures to the configured application origin using URL-origin matching.
- Terminated configured app server process trees on POSIX and Windows verification shutdown.
- Added config-driven command hooks around verification and flow phases.
- Added monorepo workspace roots for fresh verification and package-scoped command execution.
- Added a JSON Schema export and `shipgate schema` command for config tooling.
- Made `shipgate discover` crawl bounded same-origin routes before generating its smoke draft.
- Refined discovery safe mode to classify destructive candidates across labels, hrefs, form actions, control types, and report skipped unsafe candidates.
- Added opt-in discovery form mutation mode that fills safe controls while blocking form submission in generated drafts.
- Added a generated discovery review report with route, risk, form-interaction, and review checklist summaries.
- Added optional axe accessibility scanning for discovery routes and review reports.
- Added discovery screenshot baseline capture and comparison reporting.
- Added a stdio MCP server with verification, report, repair-prompt, and config-schema tools.
- Added `shipgate explain` for concise markdown or JSON summaries of the latest verification result.
- Added `shipgate repair-prompt --copy` with native clipboard command fallbacks.
- Added CI examples for GitHub Actions and GitLab CI that run fresh verification and upload `.shipgate` outputs.
- Added `shipgate view-report` to serve the latest ShipGate report as a local HTML page.
- Resolved relative API flow URLs against `app.url` and added managed API app verification coverage.
- Reworked the documentation for public usage, added a configuration reference, removed stale handoff/research docs, and licensed the package as AGPL-3.0-or-later.
- Hardened adversarial verification paths: full-output CLI expectations, command timeout diagnostics, API/readiness body timeouts, fresh-copy secret/output exclusions, package-manager detection from `packageManager`, browser cleanup on failed flows, and exact `--step` selection.
- Expanded `TODO.md` with adversarial audit findings, open hardening work, distribution options, and update-strategy notes.
- Added roadmap notes for guarded click exploration and GitHub Release tarball distribution while npm publishing is unavailable.
- Added public GitHub repository metadata for `AVANT-ICONIC/shipgate-cli`.
- Documented the temporary GitHub Release tarball install path for testers.
- Restyled the README with the public AVANT ICONIC visual format and orange-pink ShipGate branding.
- Lightened the README header and footer gradients with yellow and lime accents.
- Fixed the README release badge so it includes the current prerelease tester tarball.
- Enforced relative, project-local path validation for required files, file flows, artifact directories, and discovery output paths.
- Allowed command `cwd` movement only inside the configured workspace root so monorepo commands still work without escaping fresh copies.
- Honored artifact settings for custom artifact directories, command logs, browser screenshots, and browser traces.
- Added `shipgate update` to print or run the right GitHub Release or npm update command.
- Added `install.sh` and `scripts/release-github.mjs` for transparent GitHub Release distribution while npm publishing is unavailable.
- Bumped the tester package to `0.1.1`.

## 0.1.0 - Initial scaffold

- Created ShipGate CLI TypeScript scaffold.
- Added `init`, `verify`, `report`, `repair-prompt`, `doctor`, and `discover` commands.
- Added Zod config schema and typed `defineShipGateConfig`.
- Added fresh-copy verification core.
- Added command runner with log artifacts.
- Added Playwright browser smoke runner.
- Added markdown report and repair prompt generation.
- Added optional discovery prototype for weak smoke-test drafting.
- Added docs and agent workflow files.
