import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';

test('explicit mess budgets create stable blocking policy findings', () => {
  const root=tempRepo(); initialize(root,{existing:true});
  put(root,'src/index.ts','export const root=true;\n');
  put(root,'src/hotfix-final.ts','export const hotfix=true;\n');
  const configFile=path.join(root,'.greenroom.json');
  const raw=JSON.parse(fs.readFileSync(configFile,'utf8')); raw.budgets={'naming/suspicious':0}; fs.writeFileSync(configFile,JSON.stringify(raw,null,2));
  const result=scan(root,loadConfig(root));
  assert.ok(result.violations.some((x)=>x.rule==='policy/budget-exceeded'));
});
