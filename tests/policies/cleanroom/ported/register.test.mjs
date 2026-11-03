import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { registerCanonical } from '../../../../src/policies/cleanroom/register.mjs';
import { loadRegistry } from '../../../../src/policies/cleanroom/analyzers/registry.mjs';

test('register stores canonical responsibilities without hand-editing JSON', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/providers/ProviderLauncher.ts', 'export class ProviderLauncher {}\n');
  const config = loadConfig(root);
  registerCanonical(root, config, 'responsibility', 'provider-startup', 'src/providers/ProviderLauncher.ts', ['launch provider']);
  const registry = loadRegistry(root, config);
  assert.equal(registry.responsibilities['provider-startup'].canonical, 'src/providers/ProviderLauncher.ts');
  assert.deepEqual(registry.responsibilities['provider-startup'].aliases, ['launch provider']);
});

test('register refuses imaginary canonical paths unless explicitly planned', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  const config = loadConfig(root);
  assert.throws(() => registerCanonical(root, config, 'component', 'card', 'src/ui/Card.tsx'), /does not exist/);
  const value = registerCanonical(root, config, 'component', 'card', 'src/ui/Card.tsx', [], { allowMissing: true });
  assert.equal(value.canonical, 'src/ui/Card.tsx');
});
