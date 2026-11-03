// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import { finding, mergeFindings } from '../evidence.mjs';
import { exists, readJsonStrict } from '../lib/fs.mjs';

export function createProjectNativeProvider(config = {}) {
  return {
    id: 'project-native',
    capabilities() { return ['project-native', 'code-graph', 'runtime-evidence']; },
    available(root) {
      const rel = config.directory || '.greenroom/evidence';
      return { available: true, command: null, sourceDirectory: rel, exists: exists(path.join(root, rel)) };
    },
    scan(root) {
      const rel = config.directory || '.greenroom/evidence';
      const dir = path.join(root, rel);
      if (!exists(dir)) return { provider: 'project-native', available: true, status: 'ok', findings: [], sources: [] };
      const files = fs.readdirSync(dir, { withFileTypes: true }).filter((x) => x.isFile() && x.name.endsWith('.json')).map((x) => x.name).sort();
      const findings=[]; const sources=[]; const errors=[];
      for (const name of files) {
        try {
          const data=readJsonStrict(path.join(dir,name),`${rel}/${name}`);
          if (!data || data.version!==1 || typeof data.provider!=='string' || !Array.isArray(data.findings)) throw new Error('expected {version:1, provider, findings:[]}');
          sources.push({file:`${rel}/${name}`,provider:data.provider,capabilities:Array.isArray(data.capabilities)?data.capabilities:[]});
          for (const raw of data.findings) findings.push(finding({ ...raw, evidence:[...(raw.evidence||[]),{provider:data.provider,type:raw.kind||'project-evidence',details:{source:`${rel}/${name}`}}] }));
        } catch (error) { errors.push(`${rel}/${name}: ${error.message}`); }
      }
      return { provider:'project-native', available:true, status: errors.length ? 'partial' : 'ok', errors, sources, findings:mergeFindings(findings) };
    }
  };
}
