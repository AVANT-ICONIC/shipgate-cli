import { test } from 'vitest';
import assert from 'node:assert/strict';
import { normalizeFallow } from '../../../../src/policies/cleanroom/providers/fallow.mjs';
import { normalizeKnip } from '../../../../src/policies/cleanroom/providers/knip.mjs';

test('Fallow output normalizes into provider-neutral evidence', () => {
  const findings = normalizeFallow({
    kind: 'combined',
    check: {
      unused_files: [{ path: 'src/dead.ts', actions: [] }],
      unused_exports: [{ path: 'src/api.ts', name: 'legacy', actions: [] }],
      unused_dev_dependencies: [{ name: 'old-dev' }],
      circular_dependencies: [{ files: ['src/a.ts','src/b.ts'], line: 1, col: 0 }],
      boundary_violations: [{ from_path: 'src/ui/a.ts', to_path: 'src/db/x.ts', import_specifier: '../db/x' }]
    }
  });
  assert.ok(findings.some((x) => x.kind === 'unused-file' && x.scope.files.includes('src/dead.ts')));
  assert.ok(findings.some((x) => x.kind === 'unused-export' && x.scope.symbols.includes('legacy')));
  assert.ok(findings.some((x) => x.kind === 'dependency-cycle' && x.scope.files.includes('src/a.ts') && x.scope.files.includes('src/b.ts')));
  assert.ok(findings.some((x) => x.kind === 'boundary-violation' && x.scope.files.includes('src/ui/a.ts')));
  assert.ok(findings.every((x) => x.evidence[0].provider === 'fallow'));
});

test('Knip JSON reporter normalizes into the same evidence vocabulary', () => {
  const findings = normalizeKnip({ files: ['src/top-level-dead.ts'], issues: [
    { file: 'src/dead.ts', files: [{ name: 'src/dead.ts' }], exports: [], dependencies: [] },
    { file: 'src/api.ts', files: [], exports: [{ name: 'legacy', line: 2, col: 1 }], dependencies: [] }
  ] });
  assert.ok(findings.some((x) => x.kind === 'unused-file' && x.scope.files.includes('src/dead.ts')));
  assert.ok(findings.some((x) => x.kind === 'unused-file' && x.scope.files.includes('src/top-level-dead.ts')));
  assert.ok(findings.some((x) => x.kind === 'unused-export' && x.scope.symbols.includes('legacy')));
});

import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.mjs';
import { createFallowProvider } from '../../../../src/policies/cleanroom/providers/fallow.mjs';

test('Fallow provider accepts exit 1 as a successful findings run', () => {
  if (process.platform === 'win32') return;
  const root = tempRepo();
  const bin = path.join(root, 'fake-fallow');
  fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fallow 99.0.0"; exit 0; fi\necho '{"kind":"combined","check":{"unused_files":[{"path":"src/dead.ts"}]}}'\nexit 1\n`);
  fs.chmodSync(bin, 0o755);
  const provider = createFallowProvider({ command: bin, timeoutMs: 5000 });
  assert.equal(provider.available(root).available, true);
  const result = provider.scan(root);
  assert.equal(result.status, 'ok');
  assert.equal(result.available, true);
  assert.ok(result.findings.some((x) => x.kind === 'unused-file'));
});
