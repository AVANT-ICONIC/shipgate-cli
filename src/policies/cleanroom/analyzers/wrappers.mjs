// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path';
import { readText, matchesAnyPattern } from '../lib/fs.mjs';
import { violation } from '../violations.mjs';

const JS_EXT = new Set(['.js','.jsx','.mjs','.cjs','.ts','.tsx','.mts','.cts']);
function strip(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').trim();
}
const ONLY_REEXPORTS = /^(?:(?:export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"][^'"]+['"]\s*;?\s*)+)$/s;

export function analyzeWrappers(files, config) {
  if (!config.rules.trivialWrappers) return [];
  const allow = config.architecture?.allowTrivialWrappers || [];
  const out = [];
  for (const f of files) {
    if (!JS_EXT.has(f.ext)) continue;
    if (/^index\.(?:[cm]?[jt]sx?)$/i.test(path.basename(f.rel))) continue;
    if (matchesAnyPattern(f.rel, allow)) continue;
    const text = strip(readText(f.abs));
    if (text.length && text.length < 2000 && ONLY_REEXPORTS.test(text)) {
      out.push(violation('architecture/trivial-wrapper', [f.rel], `Trivial re-export wrapper adds an extra navigation layer: ${f.rel}`, f.rel));
    }
  }
  return out;
}
