import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';

test('package script chains are detected while matching lifecycle hooks are allowed', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'package.json', JSON.stringify({ scripts: { build: 'node x.js', prebuild: 'npm run build', deploy: 'npm run build' } }, null, 2));
  const hits = scan(root, loadConfig(root)).violations.filter((v) => v.rule === 'scripts/chain');
  assert.ok(hits.some((v) => v.message.includes('"deploy"')));
  assert.ok(!hits.some((v) => v.message.includes('"prebuild"')));
});

test('workspace package script chains are also detected', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'packages/a/package.json', JSON.stringify({ scripts: { test: 'node x.js', ci: 'npm run test' } }, null, 2));
  const hits = scan(root, loadConfig(root)).violations.filter((v) => v.rule === 'scripts/chain');
  assert.ok(hits.some((v) => v.paths.includes('packages/a/package.json')));
});
