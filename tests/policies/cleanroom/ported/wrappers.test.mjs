import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';

test('trivial non-index re-export wrappers are visible', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/real.ts', 'export const real = 1;\n');
  put(root, 'src/compat.ts', "export { real } from './real';\n");
  const result = scan(root, loadConfig(root));
  assert.ok(result.violations.some((v) => v.rule === 'architecture/trivial-wrapper'));
});

test('index barrels are not treated as accidental wrappers', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/real.ts', 'export const real = 1;\n');
  put(root, 'src/index.ts', "export { real } from './real';\n");
  const result = scan(root, loadConfig(root));
  assert.ok(!result.violations.some((v) => v.rule === 'architecture/trivial-wrapper'));
});
