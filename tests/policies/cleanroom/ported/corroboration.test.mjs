import { test } from 'vitest';
import assert from 'node:assert/strict';
import { finding } from '../../../../src/policies/cleanroom/evidence.mjs';
import { corroborate } from '../../../../src/policies/cleanroom/corroboration.mjs';

test('contradictory production evidence is visible and never grants deletion authority', () => {
  const items = [
    finding({ kind:'unused-file', scope:{files:['src/feature.ts']}, evidence:[{provider:'fallow',type:'unused-file'}], identity:'a' }),
    finding({ kind:'production-reachable', scope:{files:['src/feature.ts']}, evidence:[{provider:'graft',type:'resolved-runtime-edge'}], identity:'b' })
  ];
  const [result] = corroborate(items);
  assert.equal(result.status, 'conflicting');
  assert.equal(result.deletionAuthority, false);
  assert.equal(result.contradictoryFindings.length, 1);
});
