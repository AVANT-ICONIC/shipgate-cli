import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';
import { makeBaseline } from '../../../../src/policies/cleanroom/baseline.mjs';
import { addWaiver } from '../../../../src/policies/cleanroom/waivers.mjs';
import { evaluateCheck } from '../../../../src/policies/cleanroom/check.mjs';

test('an agent cannot add a waiver after baseline and silently pass', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/index.ts', 'export const x = 1;\n');
  const config = loadConfig(root); makeBaseline(root, config, scan(root, config));
  put(root, 'src/hotfix-final.ts', 'export const bad = 1;\n');
  const violation = scan(root, config).violations.find((v) => v.rule === 'naming/suspicious');
  addWaiver(root, config, violation, { reason: 'test exception', owner: 'test-owner', expiresAt: '2099-12-31' });
  const checked = evaluateCheck(root);
  assert.equal(checked.exitCode, 1);
  assert.ok(checked.fresh.some((v) => v.rule === 'policy/waivers-changed'));
});

test('explicit governance mode can approve a waiver', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/index.ts', 'export const x = 1;\n');
  const config = loadConfig(root); makeBaseline(root, config, scan(root, config));
  put(root, 'src/hotfix-final.ts', 'export const bad = 1;\n');
  const target = scan(root, config).violations.find((v) => v.rule === 'naming/suspicious');
  addWaiver(root, config, target, { reason: 'human-approved compatibility constraint', owner: 'human-owner', expiresAt: '2099-12-31' });
  const prior = process.env.GREENROOM_ALLOW_GOVERNANCE_UPDATE;
  process.env.GREENROOM_ALLOW_GOVERNANCE_UPDATE = '1';
  try { assert.equal(evaluateCheck(root).exitCode, 0); }
  finally { if (prior === undefined) delete process.env.GREENROOM_ALLOW_GOVERNANCE_UPDATE; else process.env.GREENROOM_ALLOW_GOVERNANCE_UPDATE = prior; }
});

test('waivers require accountable owner and expiry', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/hotfix-final.ts', 'export const bad = 1;\n');
  const config = loadConfig(root);
  const target = scan(root, config).violations.find((v) => v.rule === 'naming/suspicious');
  assert.throws(() => addWaiver(root, config, target, { reason: 'no owner' }), /owner/);
  assert.throws(() => addWaiver(root, config, target, { reason: 'no expiry', owner: 'human' }), /expires/);
});
