// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path';
import { loadRegistry } from './analyzers/registry.mjs';
import { writeJson, isSafeRelativePath, exists } from './lib/fs.mjs';

export function registerCanonical(root, config, kind, name, canonical, aliases = [], { allowMissing = false, metadata = {} } = {}) {
  if (!['responsibility', 'component'].includes(kind)) throw new Error('kind must be responsibility or component');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name || '')) throw new Error('name must be a stable slug (letters, numbers, dot, underscore, hyphen)');
  if (!isSafeRelativePath(canonical)) throw new Error('canonical path must be a safe relative path');
  if (!allowMissing && !exists(path.join(root, canonical))) throw new Error(`Canonical path does not exist: ${canonical}. Create it first or pass --allow-missing for a planned path.`);
  const registry = loadRegistry(root, config);
  const bucket = kind === 'responsibility' ? 'responsibilities' : 'components';
  registry.version ||= 1;
  registry[bucket] ||= {};
  const clean = { canonical, aliases: [...new Set(aliases.filter(Boolean))].sort() };
  if (kind === 'responsibility') {
    for (const [key, value] of Object.entries(metadata || {})) {
      if (['entrypoints','tests','docs','generated','replaces','allowedCallers','allowedDirectories','forbiddenPatterns','cleanupHistory'].includes(key)) clean[key] = [...new Set((value || []).filter(Boolean))].sort();
      else if (['owner','status'].includes(key) && value) clean[key] = String(value);
    }
  }
  registry[bucket][name] = clean;
  writeJson(path.join(root, config.registryFile), registry);
  return registry[bucket][name];
}
