import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';

// A SHARED BASENAME IS NOT THE SAME FILE.
//
// The text branch of `scripts/chain` searches a script's code for the target's
// path relative to the searching script. Two scripts in the same directory make
// that relative path a bare file name, and `text.includes('worker.mjs')` then
// matches ANY longer path ending in those characters, including a module in a
// different tree that merely shares the name.
//
// MEASURED 2026-09-18 in apex-nexus: extracting tools/grok-bot-bridge.mjs into
// packages/runtime/src/ was reported as a chain to tools/grok-bot-bridge.mjs,
// the very file the work removed the chain from. The paydown had to rename the
// module to land, which is renaming code to satisfy a detector rather than
// fixing what the detector is for.

const chains = (root) => scan(root, loadConfig(root)).violations.filter((v) => v.rule === 'scripts/chain');
const messages = (root) => chains(root).map((v) => v.message);

function repo() {
  const root = tempRepo();
  initialize(root, { existing: true });
  put(root, 'scripts/worker.mjs', 'export const work = () => 1;\n');
  put(root, 'packages/runtime/src/worker.mjs', 'export const work = () => 1;\n');
  return root;
}

test('importing a module that only shares a name with a script is not a chain', () => {
  const root = repo();
  put(root, 'scripts/caller.mjs', [
    "import { work } from '../packages/runtime/src/worker.mjs';",
    'export const n = () => work();',
    ''
  ].join('\n'));
  assert.deepEqual(messages(root).filter((m) => m.includes('caller.mjs')), []);
});

test('spawning a path that only shares a name with a script is not a chain', () => {
  const root = repo();
  put(root, 'scripts/runner.mjs', [
    "import { spawnSync } from 'node:child_process';",
    "export const go = () => spawnSync('node', ['packages/runtime/src/worker.mjs']);",
    ''
  ].join('\n'));
  assert.deepEqual(messages(root).filter((m) => m.includes('runner.mjs')), []);
});

// The other direction, in the same file, so a fix cannot pass by going blind.

test('the real sibling invocation is still reported', () => {
  const root = repo();
  put(root, 'scripts/real.mjs', [
    "import { spawnSync } from 'node:child_process';",
    "export const go = () => spawnSync('node', ['./worker.mjs']);",
    ''
  ].join('\n'));
  assert.ok(messages(root).some((m) => m.includes('scripts/real.mjs -> scripts/worker.mjs')), messages(root).join(' | '));
});

test('a bare sibling file name is still reported', () => {
  const root = repo();
  put(root, 'scripts/bare.mjs', [
    "import { spawnSync } from 'node:child_process';",
    "export const go = () => spawnSync('node', ['worker.mjs']);",
    ''
  ].join('\n'));
  assert.ok(messages(root).some((m) => m.includes('scripts/bare.mjs -> scripts/worker.mjs')), messages(root).join(' | '));
});

test('a rooted path to the script is still reported', () => {
  const root = repo();
  put(root, 'tools/rooted.mjs', [
    "import { spawnSync } from 'node:child_process';",
    "export const go = () => spawnSync('node', ['scripts/worker.mjs']);",
    ''
  ].join('\n'));
  assert.ok(messages(root).some((m) => m.includes('-> scripts/worker.mjs')), messages(root).join(' | '));
});
