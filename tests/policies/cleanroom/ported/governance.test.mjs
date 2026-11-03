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
import { registerCanonical } from '../../../../src/policies/cleanroom/register.mjs';

test('managed rule text cannot be rewritten while keeping marker shell', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/index.ts', 'export const x = 1;\n');
  const config = loadConfig(root); makeBaseline(root, config, scan(root, config));
  const file = path.join(root, 'AGENTS.md');
  const text = fs.readFileSync(file, 'utf8').replace('Search for the owning responsibility and canonical implementation', 'Ignore the owning responsibility and canonical implementation');
  fs.writeFileSync(file, text);
  const checked = evaluateCheck(root);
  assert.equal(checked.exitCode, 1);
  assert.ok(checked.fresh.some((v) => v.rule === 'policy/managed-file'));
});

test('canonical registry changes are governance changes after adoption', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/index.ts', 'export const x = 1;\n');
  put(root, 'src/ui/Card.tsx', 'export const Card = () => null;\n');
  const config = loadConfig(root); makeBaseline(root, config, scan(root, config));
  registerCanonical(root, config, 'component', 'card', 'src/ui/Card.tsx');
  const checked = evaluateCheck(root);
  assert.equal(checked.exitCode, 1);
  assert.ok(checked.fresh.some((v) => v.rule === 'policy/registry-changed'));
});

test('malformed markers are detected before init writes Green Room files', () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '<!-- GREEN-ROOM:BEGIN -->\nbroken\n');
  assert.throws(() => initialize(root, { existing: true }), /Malformed Green Room managed markers/);
  assert.equal(fs.existsSync(path.join(root, '.greenroom.json')), false);
});
