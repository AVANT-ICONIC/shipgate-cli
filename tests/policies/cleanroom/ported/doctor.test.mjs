import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';
import { sourceFiles, writeJson } from '../../../../src/policies/cleanroom/lib/fs.mjs';
import { doctor } from '../../../../src/policies/cleanroom/doctor.mjs';
import path from 'node:path';

test('doctor points agents at registered canonical implementation', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/providers/ProviderLauncher.ts', 'export class ProviderLauncher {}\n');
  const config = loadConfig(root);
  writeJson(path.join(root, config.registryFile), {
    responsibilities: { 'provider-startup': { canonical: 'src/providers/ProviderLauncher.ts', aliases: ['launch provider', 'start provider'] } },
    components: {}
  });
  const result = scan(root, config);
  const d = doctor('fix provider startup', root, config, result, sourceFiles(root, config));
  assert.equal(d.registryHits[0].canonical, 'src/providers/ProviderLauncher.ts');
});
