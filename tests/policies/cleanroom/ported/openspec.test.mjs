import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';
import { createPlan, writePlan } from '../../../../src/policies/cleanroom/plan.mjs';
import { exportCampaignToOpenSpec } from '../../../../src/policies/cleanroom/openspec.mjs';

test('cleanup campaign exports a behavior-preserving OpenSpec change without making OpenSpec mandatory', () => {
  const root = tempRepo();
  initialize(root, { existing: true });
  put(root, 'src/index.ts', 'export const root = true;\n');
  put(root, 'scripts/provider-state.ts', 'export const providerState = 1;\n');
  put(root, 'scripts/fix-provider-state.ts', 'export const fixProviderState = 2;\n');
  fs.mkdirSync(path.join(root, 'openspec', 'changes'), { recursive: true });
  const config = loadConfig(root);
  const result = scan(root, config);
  const plan = createPlan(result, { root });
  writePlan(root, plan);
  const batch = plan.phases.flatMap((x) => x.batches)[0];
  assert.ok(batch, 'expected at least one cleanup campaign');
  const id = batch.id;
  const exported = exportCampaignToOpenSpec(root, id, { validate: false, name: 'cleanup-provider-state' });
  const dir = path.join(root, exported.path);
  assert.equal(exported.skipSpecs, true);
  assert.match(fs.readFileSync(path.join(dir, '.openspec.yaml'), 'utf8'), /skip_specs: true/);
  assert.match(fs.readFileSync(path.join(dir, 'proposal.md'), 'utf8'), /behavior-preserving repository cleanup/);
  assert.match(fs.readFileSync(path.join(dir, 'design.md'), 'utf8'), new RegExp(id));
  assert.match(fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8'), /greenroom cleanup verify/);
  assert.throws(() => exportCampaignToOpenSpec(root, id, { validate: false, name: 'cleanup-provider-state' }), /already exists/);
});

test('OpenSpec export refuses to invent an OpenSpec project', () => {
  const root = tempRepo();
  put(root, 'src/fix-a.js', 'export const x = 1;\n');
  put(root, 'src/repair-a.js', 'export const x = 2;\n');
  initialize(root, { existing: true });
  const config = loadConfig(root);
  const result = scan(root, config);
  const plan = createPlan(result, { root });
  writePlan(root, plan);
  const id = plan.phases.flatMap((x) => x.batches)[0].id;
  assert.throws(() => exportCampaignToOpenSpec(root, id, { validate: false }), /OpenSpec is not initialized/);
});
