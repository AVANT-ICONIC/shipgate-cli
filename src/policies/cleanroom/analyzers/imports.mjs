// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path';
import { readText, toPosix, exists } from '../lib/fs.mjs';
import { IMPORTABLE_EXTENSIONS } from '../defaults.mjs';
import { violation } from '../violations.mjs';

const IMPORT_RE = /(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+[^'";]+?\s+from\s+|require\s*\(|import\s*\()\s*['"]([^'"]+)['"]/g;

function resolveLocal(root, fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(root, path.dirname(fromRel), spec);
  const candidates = [base, ...IMPORTABLE_EXTENSIONS.map((e) => base + e), ...IMPORTABLE_EXTENSIONS.map((e) => path.join(base, 'index' + e))];
  const hit = candidates.find(exists);
  return hit ? toPosix(path.relative(root, hit)) : null;
}

export function buildGraph(root, files) {
  const fileSet = new Set(files.map((f) => f.rel));
  const graph = new Map(files.map((f) => [f.rel, new Set()]));
  for (const f of files) {
    if (!['.js','.jsx','.mjs','.cjs','.ts','.tsx','.mts','.cts'].includes(f.ext)) continue;
    const text = readText(f.abs);
    for (const m of text.matchAll(IMPORT_RE)) {
      const resolved = resolveLocal(root, f.rel, m[1]);
      if (resolved && fileSet.has(resolved)) graph.get(f.rel).add(resolved);
    }
  }
  return graph;
}

function canonicalCycle(cycle) {
  const nodes = cycle.slice(0, -1);
  const rotations = nodes.map((_, i) => [...nodes.slice(i), ...nodes.slice(0, i)]);
  rotations.sort((a,b) => a.join('|').localeCompare(b.join('|')));
  return rotations[0];
}

export function analyzeImports(root, files, config) {
  const graph = buildGraph(root, files);
  const out = [];
  if (config.rules.dependencyCycles) {
    const state = new Map();
    const stack = [];
    const seenCycles = new Set();
    function dfs(node) {
      state.set(node, 1); stack.push(node);
      for (const dep of graph.get(node) || []) {
        if (!state.has(dep)) dfs(dep);
        else if (state.get(dep) === 1) {
          const idx = stack.indexOf(dep);
          const cyc = [...stack.slice(idx), dep];
          const canon = canonicalCycle(cyc);
          const key = canon.join('|');
          if (!seenCycles.has(key)) {
            seenCycles.add(key);
            out.push(violation('architecture/cycle', canon, `Dependency cycle: ${[...canon, canon[0]].join(' -> ')}`, key));
          }
        }
      }
      stack.pop(); state.set(node, 2);
    }
    for (const node of graph.keys()) if (!state.has(node)) dfs(node);
  }

  if (config.rules.unreachableSourceFiles) {
    const starts = (config.entrypoints || []).filter((e) => graph.has(e));
    const reachable = new Set();
    const visit = (n) => { if (reachable.has(n)) return; reachable.add(n); for (const d of graph.get(n) || []) visit(d); };
    starts.forEach(visit);
    if (starts.length) {
      for (const node of graph.keys()) {
        if (!reachable.has(node) && (config.sourceRoots || []).some((r) => node.startsWith(`${r}/`))) {
          out.push(violation('architecture/unreachable', [node], `Source file is unreachable from configured entrypoints: ${node}`, node));
        }
      }
    }
  }
  return { violations: out, graph };
}
