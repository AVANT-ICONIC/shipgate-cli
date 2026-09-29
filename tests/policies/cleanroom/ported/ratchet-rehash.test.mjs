import { test } from 'vitest';
import assert from 'node:assert/strict';

import { ratchet } from '../../../../src/policies/cleanroom/report.mjs';

const dup = (id, ...paths) => ({ id, rule: 'duplication/block', paths, message: 'Duplicated code block', detail: id });
const chain = (id, ...paths) => ({ id, rule: 'scripts/chain', paths, message: 'Script chain', detail: id });

test('editing near baselined duplication does not report it as new', () => {
  // The exact failure this guards: cleanup took a repository from 206
  // violations to 130, and the gate blocked every pull request with 11 "new"
  // violations that were all re-hashes of file pairs already in the baseline.
  const baseline = [dup('aaaa', 'a.mjs', 'b.mjs')];
  const current = [dup('bbbb', 'a.mjs', 'b.mjs')];

  const { fresh, resolved, rehashed } = ratchet(current, baseline);

  assert.equal(fresh.length, 0, 'a re-hashed block between baselined files is not new');
  assert.equal(rehashed.length, 1);
  assert.equal(resolved.length, 0, 'and it must not be claimed as cleaned up either');
});

test('a second duplicated block between the same files still blocks', () => {
  // This is the property that makes the tolerance safe. Without it, one
  // baselined duplication would license unlimited duplication between the pair.
  const baseline = [dup('aaaa', 'a.mjs', 'b.mjs')];
  const current = [dup('aaaa', 'a.mjs', 'b.mjs'), dup('cccc', 'a.mjs', 'b.mjs')];

  const { fresh } = ratchet(current, baseline);

  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].id, 'cccc');
});

test('duplication between a new pair of files blocks', () => {
  const baseline = [dup('aaaa', 'a.mjs', 'b.mjs')];
  const current = [dup('aaaa', 'a.mjs', 'b.mjs'), dup('dddd', 'c.mjs', 'd.mjs')];

  const { fresh } = ratchet(current, baseline);

  assert.equal(fresh.length, 1);
  assert.deepEqual(fresh[0].paths, ['c.mjs', 'd.mjs']);
});

test('an unchanged block keeps its own slot when a sibling is re-hashed', () => {
  const baseline = [dup('aaaa', 'a.mjs', 'b.mjs'), dup('bbbb', 'a.mjs', 'b.mjs')];
  const current = [dup('bbbb', 'a.mjs', 'b.mjs'), dup('cccc', 'a.mjs', 'b.mjs')];

  const { fresh, rehashed, resolved } = ratchet(current, baseline);

  assert.equal(fresh.length, 0);
  assert.equal(rehashed.length, 1, 'only the changed one is a re-hash');
  assert.equal(resolved.length, 0);
});

test('genuinely removing duplication is still reported as resolved', () => {
  const baseline = [dup('aaaa', 'a.mjs', 'b.mjs')];
  const current = [];

  const { fresh, resolved, rehashed } = ratchet(current, baseline);

  assert.equal(fresh.length, 0);
  assert.equal(rehashed.length, 0);
  assert.equal(resolved.length, 1);
});

test('the tolerance is limited to duplication rules', () => {
  // Other rules do not carry a content hash in their identity, so a changed id
  // there is a different finding, not the same one re-hashed.
  const baseline = [chain('aaaa', 'a.sh')];
  const current = [chain('bbbb', 'a.sh')];

  const { fresh } = ratchet(current, baseline);

  assert.equal(fresh.length, 1, 'a non-duplication rule is matched by id alone');
});

test('an empty baseline reports everything as new', () => {
  const { fresh } = ratchet([dup('aaaa', 'a.mjs', 'b.mjs')], []);
  assert.equal(fresh.length, 1);
});

test('a missing reference is treated as an empty one', () => {
  const { fresh, resolved } = ratchet([dup('aaaa', 'a.mjs', 'b.mjs')], undefined);
  assert.equal(fresh.length, 1);
  assert.equal(resolved.length, 0);
});
