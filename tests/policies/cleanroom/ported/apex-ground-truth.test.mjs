import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';

function repo() {
  const root=tempRepo(); initialize(root,{existing:true});
  put(root,'src/index.ts',"import './ui-adapter';\n");
  put(root,'src/ui-adapter.ts','export const adapter = true;\n');
  return root;
}

test('Apex #723/#726 class: implemented + tested + not production wired is stranded', () => {
  const root=repo();
  put(root,'src/brain.ts','export const brain=()=>42;\n');
  put(root,'src/brain.test.ts',"import { brain } from './brain';\nbrain();\n");
  put(root,'src/choices.ts','export const choices=()=>[1,2,3];\n');
  put(root,'src/choices.test.ts',"import { choices } from './choices';\nchoices();\n");
  const result=scan(root,loadConfig(root));
  for (const rel of ['src/brain.ts','src/choices.ts']) assert.ok(result.violations.some((x)=>x.rule==='architecture/stranded-feature' && x.paths.includes(rel)), rel);
});

test('Apex #725 class: unreachable implementation plus duplicated decision source is visible', () => {
  const root=repo();
  const shared=`\nexport const CAPABILITY_A='a';\nexport const CAPABILITY_B='b';\nexport const CAPABILITY_C='c';\nexport const CAPABILITY_D='d';\nexport const CAPABILITY_E='e';\nexport const CAPABILITY_F='f';\nexport const CAPABILITY_G='g';\nexport const CAPABILITY_H='h';\n`;
  put(root,'src/router.ts',shared+'export const route=()=>CAPABILITY_A;\n');
  put(root,'src/router.test.ts',"import { route } from './router'; route();\n");
  put(root,'src/quota-state.ts',shared+'export const quota=()=>CAPABILITY_B;\n');
  const result=scan(root,loadConfig(root));
  assert.ok(result.violations.some((x)=>x.rule==='architecture/stranded-feature' && x.paths.includes('src/router.ts')));
  assert.ok(result.violations.some((x)=>x.rule==='duplication/block'));
});

test('Apex #731 false-positive class: same private symbol name does not count as a resolved caller', () => {
  const root=repo();
  put(root,'src/capabilities.ts','export const CAPABILITIES=[\'a\',\'b\'];\n');
  put(root,'src/capabilities.test.ts',"import { CAPABILITIES } from './capabilities'; CAPABILITIES.length;\n");
  put(root,'src/unrelated.ts','const CAPABILITIES=[\'x\']; export const unrelated=CAPABILITIES.length;\n');
  // production imports unrelated, but never capabilities.ts
  fs.appendFileSync(path.join(root,'src/index.ts'),"import './unrelated';\n");
  const result=scan(root,loadConfig(root));
  assert.ok(result.violations.some((x)=>x.rule==='architecture/stranded-feature' && x.paths.includes('src/capabilities.ts')));
});
