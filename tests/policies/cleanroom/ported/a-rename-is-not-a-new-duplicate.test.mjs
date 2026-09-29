import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ratchet } from '../../../../src/policies/cleanroom/report.mjs';

// A RENAME IS NOT A NEW DUPLICATE.
//
// Matching duplication by FILE SET fixed the case where cleanup edits the lines
// around a block. It cannot survive the block's file being moved or renamed:
// the paths are the key, so the old key keeps a slot nobody claims and reads as
// resolved, and the new key has no slot and reads as fresh. The repository
// blocks itself for tidying a folder.
//
// MEASURED 2026-09-17 in apex-nexus: moving ten behaviour modules into
// packages/runtime/src/behavior/ and naming them after what they hold gave
// "Resolved 6 / NEW 6" -- the same six blocks, byte for byte, in renamed files.

const block = (id, paths, hash, line = 40) => ({
  id,
  rule: 'duplication/block',
  paths: [...paths].sort(),
  message: `Duplicated code block across ${paths.length} files`,
  detail: `${hash} ${paths.map((p) => `${p}:${line}`).join(', ')}`,
});

const OLD = ['src/dunetrace-1.mjs', 'src/dunetrace-2.mjs'];
const NEW = ['src/behavior/tool-oscillation-analyzer.mjs', 'src/behavior/goal-abandonment-detector.mjs'];

test('the same block in renamed files is re-hashed, not new, and nothing reads as resolved', () => {
  const reference = [block('aaa', OLD, '29a75d4930bc')];
  const current = [block('bbb', NEW, '29a75d4930bc')];
  const { fresh, resolved, rehashed } = ratchet(current, reference);
  assert.deepEqual(fresh, [], 'a rename introduced no entropy');
  assert.equal(rehashed.length, 1);
  assert.deepEqual(resolved, [],
    'and the old entry must not be claimed as cleanup that did not happen');
});

test('THE INVERTED CONTROL: a second, different block between the same files still blocks', () => {
  // The property #760 exists to protect. Without it this file would pass
  // against a ratchet that had simply stopped checking duplication.
  const reference = [block('aaa', OLD, '29a75d4930bc')];
  const current = [block('aaa', OLD, '29a75d4930bc'), block('ccc', OLD, 'ffffffffffff', 90)];
  const { fresh } = ratchet(current, reference);
  assert.equal(fresh.length, 1, 'a genuinely new duplicated block is still new');
  assert.equal(fresh[0].id, 'ccc');
});

test('the same block spreading to one more file still blocks', () => {
  // Same content, so a content-only key would wave this through. The count is
  // part of the key precisely so it cannot.
  const reference = [block('aaa', OLD, '29a75d4930bc')];
  const spread = [...OLD, 'src/third.mjs'];
  const current = [block('ddd', spread, '29a75d4930bc')];
  const { fresh, resolved } = ratchet(current, reference);
  assert.equal(fresh.length, 1, 'duplication reaching a third file is new');
  assert.equal(resolved.length, 1, 'and the two-file finding really is gone');
});

test('genuinely deleting the duplication is still reported as resolved', () => {
  // The other direction. A ratchet that never says "resolved" hides the work.
  const { fresh, resolved } = ratchet([], [block('aaa', OLD, '29a75d4930bc')]);
  assert.deepEqual(fresh, []);
  assert.equal(resolved.length, 1);
});

test('an unchanged block matches by id and consumes its own slot first', () => {
  // Exact matches must be taken before re-hashes, or an unchanged block and a
  // renamed one compete for one slot and one of them reads as new.
  const reference = [block('aaa', OLD, '29a75d4930bc'), block('bbb', OLD, 'ffffffffffff', 90)];
  const current = [block('aaa', OLD, '29a75d4930bc'), block('zzz', NEW, 'ffffffffffff', 90)];
  const { fresh, resolved } = ratchet(current, reference);
  assert.deepEqual(fresh, []);
  assert.deepEqual(resolved, []);
});

test('a baseline entry with no content hash falls back to the file set rather than guessing', () => {
  // An old baseline, written before the detail carried a hash. An identity we
  // cannot read is not an identity that matches.
  const legacy = { id: 'old', rule: 'duplication/block', paths: [...OLD].sort(), message: 'm', detail: 'no-hash-here' };
  const renamed = block('new', NEW, '29a75d4930bc');
  const { fresh } = ratchet([renamed], [legacy]);
  assert.equal(fresh.length, 1, 'it must not silently match a key it could not read');

  const samePaths = block('new2', OLD, '29a75d4930bc');
  assert.equal(ratchet([samePaths], [legacy]).fresh.length, 1,
    'and a hashed current entry does not claim a legacy slot by path alone');
});

test('duplication/file is still matched by file set, and says so by behaving that way', () => {
  // Its detail is the constant `exact-normalized-file`, so there is no content
  // to key on. A renamed duplicate FILE pair still re-hashes. Known gap, not a
  // silent one.
  const dupFile = (id, paths) => ({ id, rule: 'duplication/file', paths: [...paths].sort(), message: 'm', detail: 'exact-normalized-file' });
  const sameSet = ratchet([dupFile('b', OLD)], [dupFile('a', OLD)]);
  assert.deepEqual(sameSet.fresh, [], 'an id change on the same file set is still absorbed');
  const renamedSet = ratchet([dupFile('b', NEW)], [dupFile('a', OLD)]);
  assert.equal(renamedSet.fresh.length, 1, 'a rename is not absorbed for duplication/file');
});

test('a rule that is not duplication is never re-hashed by any key', () => {
  const cycle = (id, paths) => ({ id, rule: 'architecture/cycle', paths, message: 'm', detail: 'x' });
  const { fresh } = ratchet([cycle('b', OLD)], [cycle('a', OLD)]);
  assert.equal(fresh.length, 1, 'only duplication is forgiving; everything else is exact');
});

// A SHRINK IS NOT A NEW DUPLICATE EITHER.
//
// The same reasoning one step further. Taking a file OUT of a cluster changes
// the count, and the count is part of the key, so the old entry reads as
// resolved and the smaller one reads as fresh. The repository blocks itself for
// removing a duplicate, which is the single move this rule exists to ask for.
//
// MEASURED 2026-09-18 in apex-nexus: PR #840 routed council.js through a shared
// fetch helper and took it out of a six-file block. Violations fell 91 -> 90
// and the check said "Resolved 2 / NEW 1".

const SIX = [
  'apps/ui/runtime/council.js',
  'apps/ui/runtime/lib/complimentary-reviewers.js',
  'apps/ui/runtime/lib/retained-widgets.js',
  'apps/ui/runtime/lib/space-widgets.js',
  'apps/ui/runtime/lib/whiteboard.js',
  'apps/ui/runtime/lib/work-requests.js',
];
const FIVE = SIX.slice(1);

test('taking one file out of a cluster is cleanup, not new entropy', () => {
  const reference = [block('aaa', SIX, 'd307a8ceee65')];
  const current = [block('bbb', FIVE, 'd307a8ceee65')];
  const { fresh, resolved, rehashed } = ratchet(current, reference);
  assert.deepEqual(fresh, [], 'removing a duplicate must not block the PR that removed it');
  assert.equal(rehashed.length, 1);
  assert.deepEqual(resolved, [],
    'and the block is still in five files, so nothing may be claimed as resolved');
});

test('THE INVERTED CONTROL: the spread direction still blocks', () => {
  // Without this the change above would read as "stopped checking the count".
  const reference = [block('aaa', FIVE, 'd307a8ceee65')];
  const current = [block('bbb', SIX, 'd307a8ceee65')];
  const { fresh } = ratchet(current, reference);
  assert.equal(fresh.length, 1, 'a block reaching one more file is still new');
});

test('an unchanged cluster keeps its own slot, so a shrink cannot steal it', () => {
  // Two reference clusters of the same content, six files and five. The five
  // stays exactly as it was; a NEW five-file cluster of that content must not
  // take the five-file slot and must not take the six-file one either, because
  // the five-file slot is already spoken for and the six is still present.
  const OTHER_FIVE = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'];
  const reference = [block('aaa', SIX, 'd307a8ceee65'), block('bbb', OTHER_FIVE, 'd307a8ceee65')];
  const current = [
    block('aaa', SIX, 'd307a8ceee65'),
    block('bbb', OTHER_FIVE, 'd307a8ceee65'),
    block('ccc', FIVE, 'd307a8ceee65'),
  ];
  const { fresh } = ratchet(current, reference);
  assert.equal(fresh.length, 1, 'a third cluster of the same block is still new');
  assert.equal(fresh[0].id, 'ccc');
});

test('a shrink takes the smallest larger slot, not the largest', () => {
  const TEN = Array.from({ length: 10 }, (_, i) => `t${i}.js`);
  const reference = [block('big', TEN, 'd307a8ceee65'), block('aaa', SIX, 'd307a8ceee65')];
  const current = [block('big', TEN, 'd307a8ceee65'), block('bbb', FIVE, 'd307a8ceee65')];
  const { fresh, resolved } = ratchet(current, reference);
  assert.deepEqual(fresh, [], 'the six-file cluster shrank to five');
  assert.deepEqual(resolved, [],
    'the ten-file cluster is untouched and the six-file one is still present in five');
});

test('a shrink with no content hash in the detail is not guessed at', () => {
  // A baseline written before the detail carried a hash. An unreadable
  // identity is not a match, and inventing one would wave through a genuinely
  // new cluster.
  const noHash = (id, paths) => ({
    id,
    rule: 'duplication/block',
    paths: [...paths].sort(),
    message: `Duplicated code block across ${paths.length} files`,
    detail: paths.map((p) => `${p}:40`).join(', '),
  });
  const { fresh } = ratchet([noHash('bbb', FIVE)], [noHash('aaa', SIX)]);
  assert.equal(fresh.length, 1, 'without a content hash there is nothing to match on');
});
