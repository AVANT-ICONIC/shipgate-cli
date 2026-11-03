// SPDX-License-Identifier: AGPL-3.0-or-later
import { readText, isInsideAny, matchesAnyPattern } from '../lib/fs.mjs';
import { violation } from '../violations.mjs';

const COLOR = /#(?:[0-9a-fA-F]{3,8})\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g;
const RADIUS = /border-radius\s*:\s*(-?\d+(?:\.\d+)?(?:px|rem|em))/gi;
const SPACING = /(?:^|[;{\s])((?:margin|padding)(?:-(?:top|right|bottom|left))?|gap|row-gap|column-gap|inset(?:-(?:inline|block))?|top|right|bottom|left)\s*:\s*(-?\d+(?:\.\d+)?(?:px|rem|em))(?![^;{}]*var\()/gim;
const TYPOGRAPHY = /(?:^|[;{\s])(font-size|letter-spacing|line-height)\s*:\s*(-?\d+(?:\.\d+)?(?:px|rem|em))(?![^;{}]*var\()/gim;
const IMPORTANT = /!important\b/g;
const JSX_SPACING = /\b(padding|margin|gap|rowGap|columnGap|borderRadius|fontSize|letterSpacing)\s*:\s*(?:['"])?(-?\d+(?:\.\d+)?(?:px|rem|em)?)(?:['"])?/g;

function lineOf(text, index) { return text.slice(0, index).split('\n').length; }
function pushMatches(out, rule, f, text, regex, valueIndex, label) {
  for (const m of text.matchAll(regex)) {
    const line = lineOf(text, m.index || 0);
    const value = m[valueIndex];
    out.push(violation(rule, [f.rel], `Raw ${label} ${value} in ${f.rel}:${line}`, `${m[1] || label}:${value} line ${line}`));
  }
}

export function analyzeDesign(files, config) {
  if (!config.rules.rawDesignValues) return [];
  const out = [];
  const tokenFiles = new Set(config.design.tokenFiles || []);
  for (const f of files) {
    if (!['.css', '.scss', '.sass', '.less', '.tsx', '.jsx'].includes(f.ext)) continue;
    if (!isInsideAny(f.rel, config.design.roots || [])) continue;
    if (tokenFiles.has(f.rel) || matchesAnyPattern(f.rel, config.design.allow || [])) continue;
    const text = readText(f.abs);
    if (config.design.forbidRawColors) {
      for (const m of text.matchAll(COLOR)) {
        const line = lineOf(text, m.index || 0);
        out.push(violation('design/raw-color', [f.rel], `Raw design color ${m[0]} in ${f.rel}:${line}`, `${m[0]} line ${line}`));
      }
    }
    if (config.design.forbidRawRadius) pushMatches(out, 'design/raw-radius', f, text, RADIUS, 1, 'border radius');
    if (config.design.forbidRawSpacing) pushMatches(out, 'design/raw-spacing', f, text, SPACING, 2, 'spacing value');
    if (config.design.forbidRawTypography) pushMatches(out, 'design/raw-typography', f, text, TYPOGRAPHY, 2, 'typography value');
    if ((f.ext === '.tsx' || f.ext === '.jsx') && (config.design.forbidRawSpacing || config.design.forbidRawRadius || config.design.forbidRawTypography)) {
      for (const m of text.matchAll(JSX_SPACING)) {
        const prop = m[1]; const value = m[2]; const line = lineOf(text, m.index || 0);
        const rule = prop === 'borderRadius' ? 'design/raw-radius' : ['fontSize','letterSpacing'].includes(prop) ? 'design/raw-typography' : 'design/raw-spacing';
        const enabled = rule === 'design/raw-radius' ? config.design.forbidRawRadius : rule === 'design/raw-typography' ? config.design.forbidRawTypography : config.design.forbidRawSpacing;
        if (enabled) out.push(violation(rule, [f.rel], `Raw ${prop} ${value} in ${f.rel}:${line}`, `${prop}:${value} line ${line}`));
      }
    }
    if (config.design.forbidImportant) {
      for (const m of text.matchAll(IMPORTANT)) {
        const line = lineOf(text, m.index || 0);
        out.push(violation('design/important', [f.rel], `!important used in ${f.rel}:${line}`, `!important line ${line}`));
      }
    }
  }
  return out;
}
