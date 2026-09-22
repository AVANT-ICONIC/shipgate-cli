// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import { exists, readJsonStrict, isSafeRelativePath, walk, matchesAnyPattern } from '../lib/fs.mjs';
import { violation } from '../violations.mjs';
import { finding } from '../evidence.mjs';

export function emptyGeneratedRegistry() { return { version: 1, artifacts: {} }; }
export function loadGeneratedRegistry(root, config) {
  const file = path.join(root, config.generatedFile);
  if (!exists(file)) return emptyGeneratedRegistry();
  const data = readJsonStrict(file, config.generatedFile);
  if (!data || typeof data !== 'object' || data.version !== 1 || !data.artifacts || typeof data.artifacts !== 'object' || Array.isArray(data.artifacts)) throw new Error(`${config.generatedFile} must be a version 1 object with artifacts`);
  for (const [rel, item] of Object.entries(data.artifacts)) {
    if (!isSafeRelativePath(rel)) throw new Error(`${config.generatedFile} contains unsafe artifact path: ${rel}`);
    if (!item || typeof item !== 'object' || !Array.isArray(item.sources) || item.sources.some((x) => typeof x !== 'string') || typeof item.regenerate !== 'string') throw new Error(`${config.generatedFile} artifact ${rel} must have sources[] and regenerate`);
  }
  return data;
}

export function analyzeGenerated(root, config) {
  if (!config.rules.generatedArtifacts) return { violations: [], findings: [] };
  const registry = loadGeneratedRegistry(root, config);
  const all = walk(root, config);
  const violations=[]; const findings=[];
  for (const [rel, item] of Object.entries(registry.artifacts)) {
    const target = path.join(root, rel);
    if (!exists(target)) {
      violations.push(violation('generated/missing', [rel, config.generatedFile], `Registered generated artifact is missing: ${rel}`, rel));
      findings.push(finding({ kind:'generated-artifact-missing', severity:'blocking', confidence:'proven', action:'mechanical-fix', scope:{files:[rel]}, evidence:[{provider:'builtin',type:'generated-registry',details:item}], identity:`generated-missing:${rel}`, message:`Generated artifact is missing: ${rel}. Regenerate with: ${item.regenerate}` }));
      continue;
    }
    let targetMtime=0; try { targetMtime=fs.statSync(target).mtimeMs; } catch {}
    const sources = all.filter((f) => item.sources.some((pattern) => matchesAnyPattern(f.rel, [pattern])));
    const newer = sources.filter((f) => { try { return fs.statSync(f.abs).mtimeMs > targetMtime + 1; } catch { return false; } });
    if (newer.length) {
      // mtimes are useful evidence during local work, but are not deterministic enough
      // to authorize a CI block: checkout order can change them without source drift.
      // Surface staleness as review evidence; missing registered artifacts remain hard failures.
      findings.push(finding({ kind:'generated-artifact-stale', severity:'warning', confidence:'medium', action:'investigate', scope:{files:[rel,...newer.map((x)=>x.rel)]}, evidence:[{provider:'builtin',type:'mtime-vs-declared-sources',details:{regenerate:item.regenerate,sources:item.sources,newer:newer.map((x)=>x.rel)}}], identity:`generated-stale:${rel}:${newer.map((x)=>x.rel).sort().join('|')}`, message:`Generated artifact is stale: ${rel}. Regenerate with: ${item.regenerate}` }));
    }
  }
  return { violations, findings };
}
