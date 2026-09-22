import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';
import { makeBaseline } from '../../../../src/policies/cleanroom/baseline.mjs';
import { createPlan, writePlan, verifyCampaign } from '../../../../src/policies/cleanroom/plan.mjs';

test('cleanup campaign records evidence and verifies removal before marking verified', () => {
  const root=tempRepo(); initialize(root,{existing:true});
  put(root,'src/index.ts','export const root = true;\n');
  put(root,'src/widget-final.ts','export const widget = true;\n');
  const config=loadConfig(root);
  const before=scan(root,config);
  makeBaseline(root,config,before);
  const plan=createPlan(before,{root,batchSize:10}); writePlan(root,plan);
  const campaign=plan.phases.flatMap((x)=>x.batches).find((x)=>x.ratchet.targetViolationIds.length);
  assert.ok(campaign.stateMachine.includes('VERIFIED'));
  fs.unlinkSync(path.join(root,'src/widget-final.ts'));
  const verified=verifyCampaign(root,config,campaign.id,{runCommands:false});
  assert.equal(verified.ok,true);
  assert.equal(verified.state,'VERIFIED');
});
