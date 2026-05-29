# ShipGate CI

ShipGate is local-first. CI should run the same acceptance gate that developers
run locally:

```bash
shipgate verify --fresh
```

## Recommended Setup

1. Add `@shipgate/cli` as a project dev dependency.
2. Commit `shipgate.config.ts` and the project lockfile.
3. Run `shipgate verify --fresh` in CI.
4. Upload `.shipgate` reports and artifacts even when verification fails.

If your config includes browser flows, install Playwright browsers in the job or
use a Playwright-ready runner image.

For pnpm projects, a minimal job needs Corepack, dependency install, and the
fresh verification command:

```yaml
steps:
  - run: corepack enable
  - run: pnpm install --frozen-lockfile
  - run: pnpm exec shipgate verify --fresh
```

## GitHub Actions

See [examples/ci/github-actions.yml](../examples/ci/github-actions.yml).

The example:

- uses Node 20 and Corepack
- installs dependencies from the committed lockfile
- installs Chromium for browser flows
- runs `pnpm exec shipgate verify --fresh`
- uploads `.shipgate/latest-report.md`, `.shipgate/latest-result.json`,
  `.shipgate/latest-repair-prompt.md`, reports, and artifacts

## GitLab CI

See [examples/ci/gitlab-ci.yml](../examples/ci/gitlab-ci.yml).

The example follows the same contract: install from lockfile, run fresh
verification, and always preserve `.shipgate` outputs.

## Artifacts

Always preserve these paths when the job fails:

- `.shipgate/latest-report.md`
- `.shipgate/latest-result.json`
- `.shipgate/latest-repair-prompt.md`
- `.shipgate/reports`
- `.shipgate/artifacts`

Do not replace `shipgate verify --fresh` with a stale local build, a partial
command, or a report-only command. CI should exercise the same gate used for
local acceptance.
