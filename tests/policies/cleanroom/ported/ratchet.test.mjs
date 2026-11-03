import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';
import { makeBaseline } from '../../../../src/policies/cleanroom/baseline.mjs';
import { checkText } from '../../../../src/policies/cleanroom/report.mjs';

test('ratchet grandfathers old mess and blocks only new entropy', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/thing-final.ts', "export const thing = 1;\n");
  const config = loadConfig(root);
  const baselineResult = scan(root, config);
  const baseline = makeBaseline(root, config, baselineResult);
  assert.equal(checkText(baselineResult, baseline).fresh.length, 0);
  put(root, 'src/another-fix.ts', "export const another = 2;\n");
  const next = scan(root, config);
  const checked = checkText(next, baseline);
  assert.equal(checked.fresh.length, 1);
  assert.equal(checked.fresh[0].rule, 'naming/suspicious');
});
