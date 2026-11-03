// SPDX-License-Identifier: AGPL-3.0-or-later
import { loadRegistry, normalizeResponsibility } from './analyzers/registry.mjs';
import { readText } from './lib/fs.mjs';

function tokens(q) { return [...new Set(q.toLowerCase().split(/[^a-z0-9_-]+/).flatMap((x) => x.split(/[-_]/)).filter((x) => x.length > 2))]; }
function scoreText(text, ts) { const lower = String(text || '').toLowerCase(); return ts.reduce((s,t) => s + (lower.includes(t) ? 1 : 0), 0); }
function reverseGraph(graph) {
  const reverse = new Map();
  for (const node of graph.keys()) reverse.set(node, new Set());
  for (const [from, deps] of graph) for (const dep of deps) { if (!reverse.has(dep)) reverse.set(dep, new Set()); reverse.get(dep).add(from); }
  return reverse;
}

export function doctor(query, root, config, scanResult, files) {
  const ts = tokens(query);
  const registry = loadRegistry(root, config);
  const registryHits = [];
  for (const [kind, entries] of Object.entries({ responsibilities: registry.responsibilities || {}, components: registry.components || {} })) {
    for (const [name, value] of Object.entries(entries)) {
      if (kind === 'responsibilities') {
        const r = normalizeResponsibility(name, value);
        const score = scoreText(`${name} ${r.canonical.join(' ')} ${r.aliases.join(' ')} ${r.entrypoints.join(' ')} ${r.owner}`, ts);
        if (score) registryHits.push({ kind, name, canonical: r.canonical[0] || null, canonicals: r.canonical, aliases: r.aliases, responsibility: r, score });
      } else {
        const canonical = typeof value === 'string' ? value : value?.canonical;
        const aliases = typeof value === 'object' ? value?.aliases || [] : [];
        const score = scoreText(`${name} ${canonical} ${aliases.join(' ')}`, ts);
        if (score) registryHits.push({ kind, name, canonical, canonicals: canonical ? [canonical] : [], aliases, score });
      }
    }
  }
  registryHits.sort((a,b) => b.score-a.score || a.name.localeCompare(b.name));

  const fileHits = [];
  for (const f of files) {
    const nameScore = scoreText(f.rel, ts) * 3;
    let contentScore = 0;
    if (nameScore < Math.max(1, ts.length) * 3) {
      try { contentScore = Math.min(4, scoreText(readText(f.abs).slice(0, 50000), ts)); } catch {}
    }
    const score = nameScore + contentScore;
    if (score) fileHits.push({ path: f.rel, score });
  }
  for (const hit of registryHits) {
    for (const canonical of hit.canonicals || []) if (canonical && !fileHits.some((x) => x.path === canonical)) fileHits.push({ path: canonical, score: hit.score * 4 + 10, canonical: true, responsibility: hit.name });
  }
  fileHits.sort((a,b) => b.score-a.score || a.path.localeCompare(b.path));

  const relatedViolations = scanResult.violations.filter((v) => scoreText(`${v.message} ${v.paths.join(' ')}`, ts));
  const relatedFindings = (scanResult.findings || []).filter((v) => scoreText(`${v.message} ${(v.scope?.files || []).join(' ')} ${v.scope?.responsibility || ''}`, ts));
  const reverse = reverseGraph(scanResult.graph || new Map());
  const context = fileHits.slice(0, 8).map((hit) => ({
    path: hit.path,
    canonical: Boolean(hit.canonical || registryHits.some((x) => (x.canonicals || []).includes(hit.path))),
    responsibility: hit.responsibility || registryHits.find((x) => (x.canonicals || []).includes(hit.path))?.name || null,
    imports: [...(scanResult.graph?.get(hit.path) || [])].sort().slice(0, 20),
    importedBy: [...(reverse.get(hit.path) || [])].sort().slice(0, 20),
    productionReachable: scanResult.reachability?.production?.has?.(hit.path) ?? null,
    testReachable: scanResult.reachability?.tests?.has?.(hit.path) ?? null
  }));
  return {
    query,
    tokens: ts,
    registryHits: registryHits.slice(0,10),
    fileHits: fileHits.slice(0,15),
    context,
    relatedViolations: relatedViolations.slice(0,15),
    relatedFindings: relatedFindings.slice(0,15),
    providerStatus: scanResult.providers || []
  };
}

export function doctorText(r) {
  const lines = ['GREEN ROOM DOCTOR', '='.repeat(64), `Task: ${r.query}`, ''];
  lines.push('Canonical responsibility matches:');
  if (!r.registryHits.length) lines.push('  (none registered yet)');
  for (const h of r.registryHits) {
    lines.push(`  - ${h.kind}.${h.name} -> ${(h.canonicals || [h.canonical]).filter(Boolean).join(', ')}`);
    if (h.responsibility?.owner) lines.push(`    owner: ${h.responsibility.owner}`);
    if (h.responsibility?.replaces?.length) lines.push(`    replaces: ${h.responsibility.replaces.join(', ')}`);
    if (h.responsibility?.forbiddenPatterns?.length) lines.push(`    forbidden peers: ${h.responsibility.forbiddenPatterns.join(', ')}`);
  }
  lines.push('', 'Likely relevant files:');
  if (!r.fileHits.length) lines.push('  (none found)');
  for (const h of r.fileHits) lines.push(`  - ${h.path}${h.canonical ? '  [canonical]' : ''}`);
  const meaningfulContext = r.context.filter((x) => x.imports.length || x.importedBy.length || x.productionReachable !== null);
  if (meaningfulContext.length) {
    lines.push('', 'Dependency / reachability context:');
    for (const item of meaningfulContext.slice(0, 5)) {
      lines.push(`  ${item.path}${item.canonical ? ' [canonical]' : ''}${item.responsibility ? ` [${item.responsibility}]` : ''}`);
      if (item.productionReachable !== null) lines.push(`    production: ${item.productionReachable ? 'reachable' : 'NOT reachable'} · tests: ${item.testReachable ? 'reachable' : 'not reachable'}`);
      if (item.importedBy.length) lines.push(`    callers: ${item.importedBy.join(', ')}`);
      if (item.imports.length) lines.push(`    imports: ${item.imports.join(', ')}`);
    }
  }
  if (r.relatedViolations.length || r.relatedFindings.length) {
    lines.push('', 'Existing hazards / evidence in this area:');
    for (const v of r.relatedViolations) lines.push(`  - BLOCKING ${v.rule}: ${v.message} [${v.id}]`);
    for (const f of r.relatedFindings.filter((x) => !String(x.id).startsWith('v-')).slice(0,10)) lines.push(`  - ${f.confidence} ${f.kind}: ${f.message} [${f.id}]`);
  }
  lines.push('', 'Decision rule: modify the canonical responsibility when possible. One analyzer is evidence, never deletion authority. Tested-only code is not production-wired code.');
  return lines.join('\n');
}
