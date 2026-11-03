import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';
import { makeBaseline } from '../../../../src/policies/cleanroom/baseline.mjs';
import { evaluateCheck } from '../../../../src/policies/cleanroom/check.mjs';

function git(root, ...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function commitAll(root, msg) { git(root, 'add', '-A'); git(root, 'commit', '-m', msg); }

test('a cleaned legacy violation cannot be reintroduced later', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/thing-final.ts', 'export const legacy = true;\n');
  const config = loadConfig(root);
  makeBaseline(root, config, scan(root, config));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Green Room Test');
  commitAll(root, 'adopt green room');
  fs.unlinkSync(path.join(root, 'src/thing-final.ts'));
  commitAll(root, 'remove legacy violation');
  git(root, 'checkout', '-b', 'feature');
  put(root, 'src/thing-final.ts', 'export const legacy = true;\n');

  const checked = evaluateCheck(root, { explicitCompareRef: 'main' });
  assert.equal(checked.exitCode, 1);
  assert.ok(checked.fresh.some((v) => v.rule === 'naming/suspicious'));
});


test('dirty feature worktree still compares the whole branch against main', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/index.ts', 'export const clean = true;\n');
  const config = loadConfig(root);
  makeBaseline(root, config, scan(root, config));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Green Room Test');
  commitAll(root, 'adopt green room');
  git(root, 'checkout', '-b', 'feature');
  put(root, 'src/committed-final.ts', 'export const regression = true;\n');
  commitAll(root, 'commit violating change');
  put(root, 'notes.txt', 'uncommitted unrelated note\n');

  const checked = evaluateCheck(root);
  assert.equal(checked.exitCode, 1);
  assert.ok(checked.compareRef);
  assert.ok(checked.fresh.some((v) => v.rule === 'naming/suspicious' && v.paths.includes('src/committed-final.ts')));
});
