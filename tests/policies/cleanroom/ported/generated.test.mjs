import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { writeJson } from '../../../../src/policies/cleanroom/lib/fs.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';

test('registered generated artifacts surface timestamp staleness as evidence, not a CI authority', () => {
  const root=tempRepo(); initialize(root,{existing:true});
  put(root,'src/index.ts','export const root = true;\n');
  const src=put(root,'src/schema.ts','export const schema = 1;\n');
  const generated=put(root,'generated/schema.json','{"schema":1}\n');
  const config=loadConfig(root);
  writeJson(path.join(root,config.generatedFile),{version:1,artifacts:{'generated/schema.json':{sources:['src/schema.ts'],regenerate:'npm run generate:schema'}}});
  const now=Date.now()/1000;
  fs.utimesSync(generated,now-20,now-20);
  fs.utimesSync(src,now,now);
  const result=scan(root,config);
  assert.equal(result.violations.some((x)=>x.rule==='generated/stale'), false);
  const stale=result.findings.find((x)=>x.kind==='generated-artifact-stale');
  assert.ok(stale);
  assert.equal(stale.confidence,'medium');
  assert.equal(stale.action,'investigate');
});

test('a registered generated artifact that is missing is a deterministic failure', () => {
  const root=tempRepo(); initialize(root,{existing:true});
  put(root,'src/index.ts','export const root = true;\n');
  put(root,'src/schema.ts','export const schema = 1;\n');
  const config=loadConfig(root);
  writeJson(path.join(root,config.generatedFile),{version:1,artifacts:{'generated/schema.json':{sources:['src/schema.ts'],regenerate:'npm run generate:schema'}}});
  const result=scan(root,config);
  assert.ok(result.violations.some((x)=>x.rule==='generated/missing'));
});
