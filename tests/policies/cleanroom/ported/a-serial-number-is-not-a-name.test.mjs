import { test } from 'vitest';
import assert from 'node:assert/strict';
import { analyzeNaming } from '../../../../src/policies/cleanroom/analyzers/naming.mjs';

// A SERIAL NUMBER IS NOT A NAME.
//
// MEASURED 2026-09-17 in apex-nexus: 53 files named `<prefix>-<digit>.mjs`,
// 16% of a flat source directory, and 47 of them carried no header comment
// either. Every one was imported by exactly one well-named module under a
// proper symbol name -- `dunetrace-1.mjs` was always `ToolOscillationAnalyzer`
// inside. Green Room said nothing about any of them for months.
//
// The danger in the repair is the word-search mistake one more time: `sha-256`
// and `base-64` are names. What makes an index an index is a SIBLING carrying
// the same prefix and a different number, which is evidence rather than a
// guess. Every test below that asserts SILENCE is guarding that, and they are
// why this file exists.

const config = { rules: { suspiciousFilenames: true }, naming: { allow: [] } };
const files = (...rels) => rels.map((rel) => ({ rel }));
const run = (...rels) => analyzeNaming(files(...rels), config);
const serials = (...rels) => run(...rels).filter((v) => /Serial-numbered/.test(v.message));

test('two files sharing a prefix and differing only by index are both reported', () => {
  const found = serials('src/hive-1.mjs', 'src/hive-2.mjs');
  assert.equal(found.length, 2);
  assert.deepEqual(found[0].paths, ['src/hive-1.mjs', 'src/hive-2.mjs']);
  assert.match(found[0].message, /The digit is an index, not a name/);
});

test('a gapped series is still a series', () => {
  // apex had agentube-1,2,4,5 and atlas-1,3. The missing numbers are pieces
  // that were never ported, which does not make the rest names.
  assert.equal(serials('src/agentube-1.mjs', 'src/agentube-2.mjs', 'src/agentube-4.mjs', 'src/agentube-5.mjs').length, 4);
  assert.equal(serials('src/atlas-1.mjs', 'src/atlas-3.mjs').length, 2);
});

test('A LONE NUMBERED FILE IS NOT CONVICTED', () => {
  // `sha-256.mjs` with no `sha-1.mjs` beside it is a name. This is the whole
  // reason the rule needs a sibling and not just a regex.
  assert.deepEqual(serials('src/sha-256.mjs'), []);
  assert.deepEqual(serials('src/base-64.mjs', 'src/utils.mjs'), []);
  assert.deepEqual(serials('src/h-264.mjs', 'src/h-265-notes.md'), []);
});

test('a real name that happens to end in a digit stays quiet', () => {
  for (const name of ['src/oauth2.mjs', 'src/base64.mjs', 'src/sha256.mjs', 'src/utf8.mjs', 'src/h264.mjs']) {
    assert.deepEqual(serials(name), [], name);
  }
  // No separator, so nothing here is an index at all.
  assert.deepEqual(serials('src/oauth2.mjs', 'src/oauth3.mjs'), []);
});

test('the sibling must share the WHOLE prefix, not merely start the same way', () => {
  assert.deepEqual(serials('src/game-foundry-1.mjs', 'src/game-1.mjs'), [],
    'game-foundry and game are different names that both end in a digit');
  assert.equal(serials('src/game-foundry-1.mjs', 'src/game-foundry-2.mjs').length, 2);
});

test('the same number twice is not a series', () => {
  // Different extensions, same index: one module and its sibling artefact, not
  // two pieces of an extraction.
  assert.deepEqual(serials('src/thing-1.mjs', 'src/thing-1.json'), []);
});

test('a series in one directory does not convict a lone file in another', () => {
  // The subject is the `detail`, not paths[0]: paths are sorted, so both
  // findings in a pair lead with the same file.
  const found = serials('src/hive-1.mjs', 'src/hive-2.mjs', 'other/hive-1.mjs');
  assert.deepEqual(found.map((v) => v.detail).sort(), ['hive-1.mjs', 'hive-2.mjs']);
  for (const v of found) assert.ok(v.paths.every((rel) => rel.startsWith('src/')), v.paths.join(','));
});

test('the allow list silences it like every other naming finding', () => {
  const cfg = { rules: { suspiciousFilenames: true }, naming: { allow: ['src/hive-*'] } };
  assert.deepEqual(analyzeNaming(files('src/hive-1.mjs', 'src/hive-2.mjs'), cfg), []);
});

test('turning the rule off turns this off too', () => {
  const cfg = { rules: { suspiciousFilenames: false }, naming: { allow: [] } };
  assert.deepEqual(analyzeNaming(files('src/hive-1.mjs', 'src/hive-2.mjs'), cfg), []);
});

test('a version marker and a serial index are reported once each, never twice for one file', () => {
  // `thing-v2-1.mjs` could match both rules. One file, one finding.
  const found = run('src/thing-v2-1.mjs', 'src/thing-v2-2.mjs');
  const perFile = found.filter((v) => v.detail === 'thing-v2-1.mjs');
  assert.equal(perFile.length, 1, 'one file must not be convicted twice for the same name');
});

test('THE REAL SHAPE: the apex series that went unreported for months', () => {
  // The exact basenames, in the directory they really shared.
  const real = [
    'packages/runtime/src/hive-1.mjs', 'packages/runtime/src/hive-2.mjs',
    'packages/runtime/src/hive-3.mjs', 'packages/runtime/src/hive-4.mjs',
    'packages/runtime/src/hive-5.mjs',
    'packages/runtime/src/jules-dispatch-1.mjs', 'packages/runtime/src/jules-dispatch-2.mjs',
    'packages/runtime/src/jules-dispatch-3.mjs', 'packages/runtime/src/jules-dispatch-4.mjs',
    // and the files that were fine, sitting in the same directory
    'packages/runtime/src/worker-router.mjs', 'packages/runtime/src/process.mjs',
  ];
  const found = serials(...real);
  assert.equal(found.length, 9, 'nine indexed files, and only those');
  assert.deepEqual(found.filter((v) => /worker-router|\/process\./.test(v.paths[0])), []);
});
