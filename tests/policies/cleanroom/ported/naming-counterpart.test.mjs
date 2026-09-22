import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';

// A VERSION MARKER NEEDS THE FILE IT IS A VERSION OF.
//
// `naming/suspicious` convicted any filename containing fix, final, new, old,
// backup, copy, temp, tmp or v<n> anywhere. Those are ordinary English words,
// and a repository whose test names are sentences uses them constantly.
//
// MEASURED 2026-09-17 in apex-nexus: 16 findings, 15 of them sentence-shaped
// test names -- `the-new-ui-chat-sends-a-message.test.mjs`,
// `vault-backup.test.mjs` (which tests the vault's backup). None named a
// version of anything, and the rule's own advice -- migrate the callers, delete
// the superseded file -- has no meaning without a file to migrate them to.

const naming = (root) => scan(root, loadConfig(root)).violations.filter((v) => v.rule === 'naming/suspicious');

function repo(files) {
  const root = tempRepo();
  initialize(root, { existing: true });
  for (const [rel, body] of Object.entries(files)) put(root, rel, body);
  return root;
}

test('a versioned file beside the file it supersedes is the finding', () => {
  const root = repo({ 'src/utils.js': 'export const a = 1;\n', 'src/utils-v2.js': 'export const a = 2;\n' });
  const hits = naming(root);
  assert.equal(hits.length, 1, JSON.stringify(hits.map((h) => h.message)));
  assert.match(hits[0].message, /src\/utils-v2\.js sits beside src\/utils\.js/);
  assert.ok(hits[0].paths.includes('src/utils.js'), 'the counterpart is on the finding, so it is actionable');
});

test('every marker word is still caught in that form', () => {
  for (const variant of ['auth-fixed.js', 'auth-old.js', 'auth-backup.js', 'auth-copy.js',
    'auth-final.js', 'auth-new.js', 'auth-temp.js', 'auth-tmp.js', 'auth-v3.js', 'auth.old.js']) {
    const root = repo({ 'src/auth.js': 'export const a = 1;\n', [`src/${variant}`]: 'export const a = 2;\n' });
    assert.ok(naming(root).some((v) => v.paths.includes(`src/${variant}`)), `${variant} was not caught`);
  }
});

test('a leading marker is caught too, since copy-of-x is the same mistake', () => {
  const root = repo({ 'src/of-utils.js': 'export const a = 1;\n', 'src/copy-of-utils.js': 'export const a = 2;\n' });
  assert.ok(naming(root).some((v) => v.paths.includes('src/copy-of-utils.js')));
});

test('a sentence that happens to contain one of those words is not a finding', () => {
  const root = repo({
    'tests/the-new-ui-chat-sends-a-message.test.mjs': 'export const t = 1;\n',
    'tests/a-worker-must-be-able-to-pick-up-its-own-fix.test.mjs': 'export const t = 1;\n',
    'tests/nothing-new-is-unreachable.test.mjs': 'export const t = 1;\n',
    'tests/one-copy-of-a-fleet-helper-not-two.test.mjs': 'export const t = 1;\n',
    'scripts/temp-run-root.mjs': 'export const t = 1;\n'
  });
  assert.deepEqual(naming(root).map((v) => v.message), []);
});

test('a file that IS the subject is not a version of anything', () => {
  // `vault-backup.test.mjs` tests the vault's backup. Its last segment is
  // `test`, so `backup` is subject matter and not a version marker.
  const quiet = repo({ 'tests/vault-backup.test.mjs': 'export const t = 1;\n', 'tests/vault-canary.test.mjs': 'export const t = 1;\n' });
  assert.deepEqual(naming(quiet).map((v) => v.message), []);

  const loud = repo({ 'tests/vault.test.mjs': 'export const t = 1;\n', 'tests/vault-backup.test.mjs': 'export const t = 1;\n' });
  assert.ok(loud && naming(loud).some((v) => v.paths.includes('tests/vault-backup.test.mjs')),
    'and when the file it shadows IS there, the rule still fires — otherwise this proves nothing');
});

test('a leading marker needs its counterpart in the same directory', () => {
  // A word at the front is no more evidence than one in the middle. It becomes
  // evidence when the file it claims to be a copy of is lying next to it.
  const apart = repo({ 'src/a/of-utils.js': 'export const a = 1;\n', 'src/b/copy-of-utils.js': 'export const a = 2;\n' });
  assert.deepEqual(naming(apart).map((v) => v.message), []);

  const together = repo({ 'src/b/of-utils.js': 'export const a = 1;\n', 'src/b/copy-of-utils.js': 'export const a = 2;\n' });
  assert.ok(naming(together).some((v) => v.paths.includes('src/b/copy-of-utils.js')),
    'and in one directory it fires — otherwise the case above proves nothing');
});

test('a trailing marker stands on its own, counterpart or not', () => {
  // `utils-v2.js` says what it is whether or not `utils.js` survived. The base
  // name is the subject and the last segment is which copy of it this is.
  const root = repo({ 'src/utils-v2.js': 'export const a = 2;\n' });
  assert.ok(naming(root).some((v) => v.paths.includes('src/utils-v2.js')));
});

test('the marker must be a whole segment, not a fragment of a word', () => {
  const root = repo({ 'src/render.js': 'export const a = 1;\n', 'src/renderer.js': 'export const a = 2;\n',
    'src/config.js': 'export const c = 1;\n', 'src/confignew.js': 'export const c = 2;\n' });
  assert.deepEqual(naming(root).map((v) => v.message), []);
});

test('the allow list still silences a path', () => {
  const root = repo({ 'src/utils.js': 'export const a = 1;\n', 'src/utils-v2.js': 'export const a = 2;\n' });
  put(root, '.greenroom.json', JSON.stringify({ ...JSON.parse(readFileSync(`${root}/.greenroom.json`, 'utf8')), naming: { allow: ['src/utils-v2.js'] } }, null, 2));
  assert.deepEqual(naming(root).map((v) => v.message), []);
});
