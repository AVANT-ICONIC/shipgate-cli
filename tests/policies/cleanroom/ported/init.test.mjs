import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';

test('init creates portable guard files and is idempotent', () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Existing Rules\n\nDo not delete this.\n');
  const first = initialize(root, { existing: true });
  assert.ok(first.created.includes('.greenroom.json'));
  assert.ok(fs.existsSync(path.join(root, '.greenroom/registry.json')));
  assert.ok(fs.existsSync(path.join(root, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(root, 'CLAUDE.md')));
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /Do not delete this/);
  assert.match(agents, /GREEN-ROOM:BEGIN/);
  assert.ok(fs.existsSync(path.join(root, '.github/workflows/green-room.yml')));
  const second = initialize(root, { existing: true });
  assert.equal(second.created.length, 0);
});
