import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';

test('design guard catches raw colors, spacing, radius and typography outside token files', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/styles/tokens.css', ':root { --space-2: 8px; --text: #fff; }\n');
  put(root, 'src/Card.css', '.card { color:#fff; padding:8px; border-radius:12px; font-size:16px; }\n');
  const rules = new Set(scan(root, loadConfig(root)).violations.map((v) => v.rule));
  assert.ok(rules.has('design/raw-color'));
  assert.ok(rules.has('design/raw-spacing'));
  assert.ok(rules.has('design/raw-radius'));
  assert.ok(rules.has('design/raw-typography'));
});
