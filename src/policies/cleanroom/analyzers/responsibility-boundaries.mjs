// SPDX-License-Identifier: AGPL-3.0-or-later
import { matchesAnyPattern } from '../lib/fs.mjs';
import { violation } from '../violations.mjs';
import { responsibilityMap } from './registry.mjs';

function allowedPath(rel, patterns = []) {
  return patterns.some((pattern) => {
    if (pattern.includes('*') || pattern.includes('?')) return matchesAnyPattern(rel, [pattern]);
    const root = pattern.replace(/\/$/, '');
    return rel === root || rel.startsWith(`${root}/`);
  });
}

/** Enforce explicitly declared responsibility boundaries using resolved import edges only. */
export function analyzeResponsibilityBoundaries(root, graph, config) {
  if (!config.rules.canonicalRegistry) return [];
  const responsibilities = responsibilityMap(root, config);
  const out = [];
  for (const [name, r] of Object.entries(responsibilities)) {
    if (r.allowedDirectories.length) {
      for (const canonical of r.canonical) {
        if (!allowedPath(canonical, r.allowedDirectories)) {
          out.push(violation(
            'registry/outside-allowed-directory',
            [config.registryFile, canonical],
            `Canonical path for responsibility "${name}" is outside its allowed directories: ${canonical}`,
            `${name}:${canonical}`
          ));
        }
      }
    }
    if (!r.allowedCallers.length) continue;
    for (const canonical of r.canonical) {
      for (const [caller, deps] of graph.entries()) {
        if (!deps.has(canonical)) continue;
        if (!allowedPath(caller, r.allowedCallers)) {
          out.push(violation(
            'registry/disallowed-caller',
            [caller, canonical, config.registryFile],
            `Responsibility "${name}" is imported by disallowed caller ${caller}`,
            `${name}:${caller}->${canonical}`
          ));
        }
      }
    }
  }
  return out;
}
