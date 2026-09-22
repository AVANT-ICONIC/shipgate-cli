import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';

test('fix/repair peer with the same responsibility signature is surfaced', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/index.ts', 'export const root = true;\n');
  put(root, 'scripts/provider-state.ts', 'export const providerState = 1;\n');
  put(root, 'scripts/fix-provider-state.ts', 'export const fixProviderState = 2;\n');
  const result = scan(root, loadConfig(root));
  assert.ok(result.violations.some((x) => x.rule === 'architecture/competing-responsibility'));
  assert.ok(result.findings.some((x) => x.kind === 'competing-responsibility'));
});
