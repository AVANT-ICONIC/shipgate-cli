import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';
import { writeJson } from '../../../../src/policies/cleanroom/lib/fs.mjs';
import path from 'node:path';

test('responsibility caller boundaries use resolved imports rather than symbol text', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/core/auth.ts', 'export const login = () => true;\n');
  put(root, 'src/allowed/use.ts', "import { login } from '../core/auth'; export const x = login();\n");
  put(root, 'src/bad/use.ts', "import { login } from '../core/auth'; export const y = login();\n");
  put(root, 'src/index.ts', "import './allowed/use'; import './bad/use';\n");
  writeJson(path.join(root, '.greenroom/registry.json'), {
    version: 1,
    responsibilities: {
      auth: { canonical: 'src/core/auth.ts', allowedDirectories: ['src/core'], allowedCallers: ['src/allowed/**'] }
    },
    components: {}
  });
  const result = scan(root, loadConfig(root));
  const callers = result.violations.filter((x) => x.rule === 'registry/disallowed-caller');
  assert.equal(callers.length, 1);
  assert.ok(callers[0].paths.includes('src/bad/use.ts'));
});
