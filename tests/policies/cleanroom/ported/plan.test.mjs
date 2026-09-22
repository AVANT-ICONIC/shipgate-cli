import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';
import { createPlan, writePlan } from '../../../../src/policies/cleanroom/plan.mjs';

test('cleanup planning is non-destructive and writes staged campaign', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/Widget-v2.ts', 'export const x = 1;\n');
  const original = fs.readFileSync(path.join(root, 'src/Widget-v2.ts'), 'utf8');
  const plan = createPlan(scan(root, loadConfig(root)));
  writePlan(root, plan);
  assert.ok(plan.phases.length >= 1);
  assert.ok(fs.existsSync(path.join(root, '.greenroom/cleanup-plan.md')));
  assert.equal(fs.readFileSync(path.join(root, 'src/Widget-v2.ts'), 'utf8'), original);
});
