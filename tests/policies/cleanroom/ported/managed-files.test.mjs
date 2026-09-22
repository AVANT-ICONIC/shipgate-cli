import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';
import { makeBaseline } from '../../../../src/policies/cleanroom/baseline.mjs';
import { evaluateCheck } from '../../../../src/policies/cleanroom/check.mjs';

test('deleting managed agent rules is blocked', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/index.ts', 'export const x = 1;\n');
  const config = loadConfig(root); makeBaseline(root, config, scan(root, config));
  fs.unlinkSync(path.join(root, 'AGENTS.md'));
  const checked = evaluateCheck(root);
  assert.equal(checked.exitCode, 1);
  assert.ok(checked.fresh.some((v) => v.rule === 'policy/managed-file'));
});

test('init refuses malformed managed markers rather than clobbering content', () => {
  const root = tempRepo();
  const agents = path.join(root, 'AGENTS.md');
  fs.writeFileSync(agents, '# Existing\n\n<!-- GREEN-ROOM:BEGIN -->\ncustom content\n');
  assert.throws(() => initialize(root, { existing: true }), /Malformed Green Room managed markers/);
  assert.match(fs.readFileSync(agents, 'utf8'), /custom content/);
});
