import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';
import { makeBaseline } from '../../../../src/policies/cleanroom/baseline.mjs';
import { createPlan, writePlan, verifyCampaign, approveCampaign } from '../../../../src/policies/cleanroom/plan.mjs';

test('deletion-sensitive campaign cannot verify while approval is pending', () => {
  const root=tempRepo(); initialize(root,{existing:true});
  put(root,'src/index.ts',"import {x} from './a'; export {x};\n");
  put(root,'src/a.ts','export const x=1;\n');
  put(root,'src/a-copy.ts','export const x=1;\n');
  const config=loadConfig(root); const before=scan(root,config); makeBaseline(root,config,before);
  const plan=createPlan(before,{root,batchSize:20}); writePlan(root,plan);
  const campaign=plan.phases.flatMap((x)=>x.batches).find((x)=>x.approval.required && x.ratchet.targetViolationIds.length);
  assert.ok(campaign);
  for (const rel of campaign.paths) if (rel.includes('copy') && fs.existsSync(path.join(root,rel))) fs.unlinkSync(path.join(root,rel));
  const blocked=verifyCampaign(root,config,campaign.id,{runCommands:false});
  assert.equal(blocked.ok,false); assert.equal(blocked.approvalPending,true);
  approveCampaign(root,campaign.id,{owner:'human',reason:'canonical owner verified',canonicalDecision:'src/a.ts',behaviorMustSurvive:['export x']});
  const checked=verifyCampaign(root,config,campaign.id,{runCommands:false});
  assert.equal(checked.approvalPending,false);
});
