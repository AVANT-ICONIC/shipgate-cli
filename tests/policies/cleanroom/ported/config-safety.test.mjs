import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';

test('invalid policy JSON fails closed instead of falling back to defaults', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  fs.writeFileSync(path.join(root, '.greenroom.json'), '{ nope');
  assert.throws(() => loadConfig(root), /Invalid JSON/);
});

test('unknown rule keys are rejected to catch policy typos', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  const file = path.join(root, '.greenroom.json');
  const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  policy.rules.duplicateFiels = false;
  fs.writeFileSync(file, JSON.stringify(policy, null, 2));
  assert.throws(() => loadConfig(root), /Unknown rules key/);
});


test('unknown distribution keys are rejected instead of silently weakening CI', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  const file = path.join(root, '.greenroom.json');
  const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  policy.distribution.checkComand = 'true';
  fs.writeFileSync(file, JSON.stringify(policy, null, 2));
  assert.throws(() => loadConfig(root), /Unknown distribution key/);
});
