// SPDX-License-Identifier: AGPL-3.0-or-later
import { commandAvailability, runNamedJson, relativePath } from './util.mjs';
import { finding, mergeFindings } from '../evidence.mjs';

const KIND_MAP = {
  exports: 'unused-export', nsExports: 'unused-export', types: 'unused-type', nsTypes: 'unused-type',
  dependencies: 'unused-dependency', devDependencies: 'unused-dependency', optionalPeerDependencies: 'unused-dependency',
  unlisted: 'unlisted-dependency', unresolved: 'unresolved-import', binaries: 'unused-binary', duplicates: 'duplicate-export', cycles: 'dependency-cycle'
};

function unusedFile(out, raw, fallback = '') {
  const file = relativePath(typeof raw === 'string' ? raw : raw?.file || raw?.path || raw?.name || fallback);
  if (!file) return;
  out.push(finding({
    kind: 'unused-file', confidence: 'high', severity: 'warning', action: 'cleanup-candidate',
    scope: { files: [file] }, evidence: [{ provider: 'knip', type: 'files', details: raw }],
    identity: `knip:files:${file}`, message: `Knip reports unused file: ${file}`
  }));
}

export function normalizeKnip(data) {
  const out = [];
  for (const file of data?.files || []) unusedFile(out, file);
  for (const group of data?.issues || []) {
    const file = relativePath(group.file || group.path);
    for (const [key, list] of Object.entries(group)) {
      if (key === 'file' || key === 'path' || key === 'owners' || !Array.isArray(list)) continue;
      if (key === 'files') { for (const item of list) unusedFile(out, item, file); continue; }
      if (!KIND_MAP[key]) continue;
      for (const raw of list) {
        const item = typeof raw === 'string' ? { name: raw } : raw;
        const name = String(item?.name || item?.specifier || item?.symbol || '');
        out.push(finding({
          kind: KIND_MAP[key], confidence: 'high', severity: 'warning', action: 'cleanup-candidate',
          scope: { files: file ? [file] : [], symbols: name ? [name] : [] },
          evidence: [{ provider: 'knip', type: key, details: item }],
          identity: `knip:${key}:${file}:${name}`,
          message: `Knip reported ${key}${file ? ` in ${file}` : ''}${name ? `: ${name}` : ''}`
        }));
      }
    }
  }
  return mergeFindings(out);
}

export function createKnipProvider(config = {}) {
  return {
    id: 'knip',
    capabilities() { return ['reachability', 'unused-code', 'dependencies']; },
    available(root) {
      return commandAvailability(root, 'knip', config.command);
    },
    scan(root) {
      const run = runNamedJson(root, 'knip', config.command, ['--reporter', 'json', '--no-progress'], { timeoutMs: config.timeoutMs || 120000 });
      if (!run.available) return { provider: 'knip', available: false, status: run.unavailable ? 'unavailable' : 'error', errors: run.errors || [], findings: [] };
      return { provider: 'knip', available: true, status: 'ok', command: run.command, findings: normalizeKnip(run.data) };
    }
  };
}
