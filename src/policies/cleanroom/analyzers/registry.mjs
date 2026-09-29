// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path';
import { readJsonStrict, exists, isSafeRelativePath, matchesAnyPattern } from '../lib/fs.mjs';
import { violation } from '../violations.mjs';
import { finding } from '../evidence.mjs';

function emptyRegistry() { return { version: 1, responsibilities: {}, components: {} }; }
function normalizeLabel(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function stem(rel) { return normalizeLabel(path.basename(rel, path.extname(rel))); }
function arr(value) { return Array.isArray(value) ? value.filter((x) => typeof x === 'string') : []; }

export function canonicalPathsForResponsibility(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value.canonical)) return value.canonical.filter((x) => typeof x === 'string');
  return typeof value.canonical === 'string' ? [value.canonical] : [];
}

export function normalizeResponsibility(name, value) {
  const canonical = canonicalPathsForResponsibility(value);
  const obj = typeof value === 'object' && value ? value : {};
  return {
    name,
    canonical,
    aliases: arr(obj.aliases),
    entrypoints: arr(obj.entrypoints),
    tests: arr(obj.tests),
    docs: arr(obj.docs),
    generated: arr(obj.generated),
    replaces: arr(obj.replaces),
    allowedCallers: arr(obj.allowedCallers),
    allowedDirectories: arr(obj.allowedDirectories),
    forbiddenPatterns: arr(obj.forbiddenPatterns),
    cleanupHistory: arr(obj.cleanupHistory),
    owner: typeof obj.owner === 'string' ? obj.owner : '',
    status: typeof obj.status === 'string' ? obj.status : (canonical.length ? 'canonical' : 'unknown')
  };
}

function validatePathArray(values, label) {
  for (const value of values) if (!isSafeRelativePath(value)) throw new Error(`${label} contains unsafe path: ${value}`);
}

export function loadRegistry(root, config) {
  const p = path.join(root, config.registryFile);
  if (!exists(p)) return emptyRegistry();
  const registry = readJsonStrict(p, config.registryFile);
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error(`${config.registryFile} must contain an object`);
  registry.version ||= 1;
  registry.responsibilities ||= {};
  registry.components ||= {};
  if (typeof registry.responsibilities !== 'object' || Array.isArray(registry.responsibilities)) throw new Error(`${config.registryFile}.responsibilities must be an object`);
  if (typeof registry.components !== 'object' || Array.isArray(registry.components)) throw new Error(`${config.registryFile}.components must be an object`);
  for (const [name, raw] of Object.entries(registry.responsibilities)) {
    const r = normalizeResponsibility(name, raw);
    validatePathArray([...r.canonical, ...r.entrypoints, ...r.tests, ...r.docs, ...r.generated, ...r.replaces, ...r.allowedCallers, ...r.allowedDirectories], `${config.registryFile}.responsibilities.${name}`);
  }
  return registry;
}

export function responsibilityMap(root, config) {
  const registry = loadRegistry(root, config);
  return Object.fromEntries(Object.entries(registry.responsibilities || {}).map(([name, value]) => [name, normalizeResponsibility(name, value)]));
}

export function analyzeRegistry(root, files, config) {
  if (!config.rules.canonicalRegistry) return { violations: [], findings: [] };
  const registry = loadRegistry(root, config);
  const seen = new Map();
  const out = [];
  const findings = [];
  for (const [kind, entries] of Object.entries({ responsibilities: registry.responsibilities || {}, components: registry.components || {} })) {
    for (const [name, value] of Object.entries(entries)) {
      const canonicals = kind === 'responsibilities' ? canonicalPathsForResponsibility(value) : [typeof value === 'string' ? value : value?.canonical].filter(Boolean);
      const aliases = typeof value === 'object' && Array.isArray(value?.aliases) ? value.aliases : [];
      if (!canonicals.length || canonicals.some((canonical) => !isSafeRelativePath(canonical))) {
        out.push(violation('registry/missing-canonical', [config.registryFile], `Registry entry ${kind}.${name} has no valid canonical path`, `${kind}.${name}`));
        continue;
      }
      for (const canonical of canonicals) {
        const key = canonical.toLowerCase();
        if (seen.has(key)) out.push(violation('registry/duplicate-responsibility', [config.registryFile], `Registry maps multiple concepts to the same canonical path: ${seen.get(key)} and ${kind}.${name}`, canonical));
        else seen.set(key, `${kind}.${name}`);
        if (!exists(path.join(root, canonical))) out.push(violation('registry/missing-canonical', [config.registryFile, canonical], `Registered canonical path does not exist: ${kind}.${name} -> ${canonical}`, `${kind}.${name}->${canonical}`));
      }
      if (kind === 'components') {
        const canonical = canonicals[0];
        const labels = new Set([name, ...aliases].map(normalizeLabel).filter(Boolean));
        for (const file of files) {
          if (file.rel === canonical) continue;
          if (labels.has(stem(file.rel))) out.push(violation('registry/noncanonical-component', [canonical, file.rel], `Component "${name}" has a non-canonical peer: ${file.rel}; canonical is ${canonical}`, `${name}:${file.rel}`));
        }
      }
      if (kind === 'responsibilities' && typeof value === 'object' && value) {
        const r = normalizeResponsibility(name, value);
        const existingReplaced = r.replaces.filter((rel) => exists(path.join(root, rel)));
        if (existingReplaced.length) {
          findings.push(finding({
            kind: 'replaced-implementation-still-present', severity: 'warning', confidence: 'proven', action: 'cleanup-candidate',
            scope: { files: [...r.canonical, ...existingReplaced], responsibility: name }, canonical_candidate: r.canonical[0] || null,
            evidence: [{ provider: 'builtin', type: 'responsibility-registry-replaces', details: { replaces: r.replaces } }],
            identity: `replaced:${name}:${existingReplaced.sort().join('|')}`,
            message: `Responsibility "${name}" still contains registered replaced implementations: ${existingReplaced.join(', ')}`
          }));
        }
        for (const pattern of r.forbiddenPatterns) {
          const peers = files.filter((f) => matchesAnyPattern(f.rel, [pattern]) && !r.canonical.includes(f.rel));
          for (const peer of peers) findings.push(finding({
            kind:'forbidden-responsibility-peer', severity:'blocking', confidence:'proven', action:'human-review-required',
            scope:{files:[...r.canonical,peer.rel], responsibility:name}, canonical_candidate:r.canonical[0]||null,
            evidence:[{provider:'builtin',type:'responsibility-forbidden-pattern',details:{pattern}}], identity:`forbidden-peer:${name}:${peer.rel}`,
            message:`Responsibility "${name}" forbids competing path ${peer.rel} (pattern ${pattern})`
          }));
        }
      }
    }
  }
  return { violations: out, findings };
}
