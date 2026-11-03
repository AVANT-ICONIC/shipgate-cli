import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';

test('audit detects cycles, script chains, design violations and suspicious names', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/a.ts', "import { b } from './b'; export const a = b + 1;\n");
  put(root, 'src/b.ts', "import { a } from './a'; export const b = a + 1;\n");
  put(root, 'src/Card-final.tsx', "export const Card=()=> <div style={{color:'#ff00aa'}}>x</div>;\n");
  put(root, 'scripts/one.ts', "import './two'; console.log('one');\n");
  put(root, 'scripts/two.ts', "console.log('two');\n");
  const result = scan(root, loadConfig(root));
  const rules = new Set(result.violations.map((v) => v.rule));
  assert.ok(rules.has('architecture/cycle'));
  assert.ok(rules.has('scripts/chain'));
  assert.ok(rules.has('design/raw-color'));
  assert.ok(rules.has('naming/suspicious'));
});
