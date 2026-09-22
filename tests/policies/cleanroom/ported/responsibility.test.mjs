import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { registerCanonical } from '../../../../src/policies/cleanroom/register.mjs';
import { responsibilityMap } from '../../../../src/policies/cleanroom/analyzers/registry.mjs';

test('responsibility registry stores ownership, production roots and replacement history', () => {
  const root=tempRepo(); initialize(root,{existing:true});
  put(root,'src/provider-state.ts','export const state = 1;\n');
  const config=loadConfig(root);
  registerCanonical(root,config,'responsibility','provider-state','src/provider-state.ts',['provider state'],{metadata:{owner:'runtime',entrypoints:['src/index.ts'],tests:['tests/provider-state.test.ts'],replaces:['scripts/fix-provider-state.ts'],forbiddenPatterns:['scripts/*provider-state*']}});
  const r=responsibilityMap(root,config)['provider-state'];
  assert.equal(r.owner,'runtime');
  assert.deepEqual(r.replaces,['scripts/fix-provider-state.ts']);
  assert.deepEqual(r.forbiddenPatterns,['scripts/*provider-state*']);
});
