import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';
import { makeBaseline, loadBaseline } from '../../../../src/policies/cleanroom/baseline.mjs';
import { integrityViolations } from '../../../../src/policies/cleanroom/integrity.mjs';

test('policy changes are detected after baseline', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/index.ts', 'export const x = 1;\n');
  let config = loadConfig(root);
  makeBaseline(root, config, scan(root, config));
  const configPath = path.join(root, '.greenroom.json');
  const edited = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  edited.rules.suspiciousFilenames = false;
  fs.writeFileSync(configPath, JSON.stringify(edited, null, 2));
  config = loadConfig(root);
  const issues = integrityViolations(root, config, loadBaseline(root, config));
  assert.ok(issues.some((v) => v.rule === 'policy/config-changed'));
});

test('feature PR cannot silently replace baseline', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/index.ts', 'export const x = 1;\n');
  const config = loadConfig(root);
  makeBaseline(root, config, scan(root, config));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Green Room Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root });
  execFileSync('git', ['checkout', '-b', 'feature'], { cwd: root });
  const baselinePath = path.join(root, config.baselineFile);
  const changed = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  changed.violations.push({ id: 'fake', rule: 'fake', paths: [], message: 'fake', detail: '' });
  fs.writeFileSync(baselinePath, JSON.stringify(changed, null, 2));
  const prior = process.env.GREENROOM_BASE_REF;
  process.env.GREENROOM_BASE_REF = 'main';
  try {
    const issues = integrityViolations(root, config, changed);
    assert.ok(issues.some((v) => v.rule === 'policy/baseline-changed'));
  } finally {
    if (prior === undefined) delete process.env.GREENROOM_BASE_REF; else process.env.GREENROOM_BASE_REF = prior;
  }
});
