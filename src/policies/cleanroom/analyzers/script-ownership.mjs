// SPDX-License-Identifier: AGPL-3.0-or-later
import { isInsideAny } from '../lib/fs.mjs';
import { loadRegistry, canonicalPathsForResponsibility } from './registry.mjs';
import { violation } from '../violations.mjs';
import { finding } from '../evidence.mjs';

export function analyzeScriptOwnership(root, files, config) {
  if (!config.rules.unownedScripts && !config.scripts?.requireOwnership) return { violations: [], findings: [] };
  const registry = loadRegistry(root, config);
  const ownership = new Map();
  for (const [name, raw] of Object.entries(registry.responsibilities || {})) {
    for (const rel of canonicalPathsForResponsibility(raw)) ownership.set(rel, name);
    for (const rel of raw?.replaces || []) ownership.set(rel, name);
    for (const rel of raw?.entrypoints || []) ownership.set(rel, name);
  }
  const violations=[]; const findings=[];
  for (const f of files.filter((x) => isInsideAny(x.rel, config.scriptRoots || []))) {
    if (ownership.has(f.rel)) continue;
    const item=finding({kind:'unowned-script',severity:'warning',confidence:'proven',action:'human-review-required',scope:{files:[f.rel]},evidence:[{provider:'builtin',type:'registry-ownership',details:{owned:false}}],identity:`unowned-script:${f.rel}`,message:`Script has no declared responsibility owner: ${f.rel}`});
    findings.push(item);
    if (config.scripts?.requireOwnership) violations.push(violation('scripts/unowned',[f.rel],`Script has no declared responsibility owner: ${f.rel}`,f.rel));
  }
  return { violations, findings };
}
