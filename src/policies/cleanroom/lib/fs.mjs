// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { SOURCE_EXTENSIONS } from '../defaults.mjs';

export const toPosix = (p) => p.split(path.sep).join('/');
export const exists = (p) => fs.existsSync(p);
export const readText = (p) => fs.readFileSync(p, 'utf8');
export const readJson = (p, fallback = null) => {
  try { return JSON.parse(readText(p)); } catch { return fallback; }
};
export const readJsonStrict = (p, label = toPosix(p)) => {
  let raw;
  try { raw = readText(p); }
  catch (error) { throw new Error(`Cannot read ${label}: ${error.message}`); }
  try { return JSON.parse(raw); }
  catch (error) { throw new Error(`Invalid JSON in ${label}: ${error.message}`); }
};
export const writeJson = (p, value) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n');
};
export const writeText = (p, value) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, value);
};
export const sha = (input) => crypto.createHash('sha256').update(input).digest('hex');

function escapeRegex(s) { return s.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'); }
export function globRegex(pattern) {
  const p = toPosix(pattern);
  let out = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') { i++; out += '(?:.*/)?'; }
        else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += escapeRegex(c);
  }
  return new RegExp(out + '$');
}
export function matchesAnyPattern(rel, patterns = []) {
  const p = toPosix(rel);
  return patterns.some((pattern) => globRegex(pattern).test(p));
}

export function isSafeRelativePath(value, { allowDot = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (path.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(toPosix(value));
  return normalized !== '..' && !normalized.startsWith('../') && (allowDot || normalized !== '.');
}


/**
 * What git ignores in this repository, as a set of repo-relative paths.
 *
 * WHY THIS EXISTS. The walker knew only the `ignore` list, which is a
 * hand-written approximation of a .gitignore: node_modules, dist, build,
 * .next, coverage, .turbo, .cache, vendor, target. Anything a project ignores
 * that is not on that list was scanned as if it were the project's own source.
 *
 * MEASURED 2026-09-17 in apex-nexus: `.apex/` is gitignored scratch holding
 * two vendored checkouts, and Green Room reported 75 NEW structural violations
 * against them -- dependency cycles, trivial wrappers and script chains inside
 * somebody else's code. `greenroom check` was BLOCKED in the working checkout
 * and PASSED in a clean worktree of the same commit, because the untracked
 * scratch existed in one and not the other. A gate whose verdict depends on
 * what is lying around beside the repository is not a gate.
 *
 * One `git ls-files` call, collapsed to directories, so a vendored tree costs
 * one entry rather than thousands. Not a repository, no git, or any failure:
 * an empty set, and the walk behaves exactly as it did before.
 */
export function gitIgnoredPaths(root) {
  const result = spawnSync(
    'git',
    ['-C', root, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0 || typeof result.stdout !== 'string') return new Set();
  return new Set(
    result.stdout
      .split('\n')
      .map((line) => line.trim().replace(/\/$/, ''))
      .filter(Boolean),
  );
}

export function walk(root, config) {
  const out = [];
  const ignored = new Set(config.ignore || []);
  const ignorePatterns = config.ignorePatterns || [];
  const maxBytes = Number(config.maxFileBytes || 0);
  // A project's own .gitignore is the authority on what is not its source.
  // `respectGitignore: false` opts out; anything else, including an absent
  // key, respects it.
  const gitIgnored = config.respectGitignore === false ? new Set() : gitIgnoredPaths(root);
  function visit(abs) {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (ignored.has(entry.name)) continue;
      const full = path.join(abs, entry.name);
      const rel = toPosix(path.relative(root, full));
      if (gitIgnored.has(rel)) continue;
      if (matchesAnyPattern(rel, ignorePatterns)) continue;
      if (entry.isDirectory()) visit(full);
      else {
        if (maxBytes > 0) {
          try { if (fs.statSync(full).size > maxBytes) continue; } catch { continue; }
        }
        out.push({ abs: full, rel, ext: path.extname(entry.name).toLowerCase() });
      }
    }
  }
  visit(root);
  return out;
}

export function sourceFiles(root, config) {
  return walk(root, config).filter((f) => SOURCE_EXTENSIONS.has(f.ext));
}

export function isInsideAny(rel, roots = []) {
  return roots.some((r) => rel === r || rel.startsWith(`${r}/`));
}

// A `/` opens a regular expression only where a value cannot already be sitting.
// After an identifier, a number, `)`, `]` or `}` it is division.
const VALUE_ENDS = /[\w$)\]}]/;

/**
 * The same source with every comment blanked out.
 *
 * WHY. A rule that searches a file for another file's path cannot tell an
 * invocation from a citation, and a codebase that documents itself is full of
 * citations: `// MEASURED 2026-09-17, each file run on its own by
 * scripts/measure-file-cost.mjs`.
 *
 * MEASURED 2026-09-17 in apex-nexus: `scripts/chain` reported 78 violations. 37
 * of them were a file name inside a comment -- a reference in prose, a "see
 * also", a note recording where a number came from. Nearly half the rule's
 * output convicted the repository of writing down what it did.
 *
 * Comment bodies become spaces rather than vanishing, so every line and column
 * in the result still points at the same place in the original.
 *
 * Strings, template literals and regular expressions are tracked, because a
 * `//` inside a URL and a `/*` inside a pattern are not comments. A `'` or `"`
 * string cannot cross a line in JavaScript, so that state is dropped at each
 * newline: a quote this misreads can cost one line and never the rest of a file.
 */
export function codeWithoutComments(text) {
  if (typeof text !== 'string') return '';
  const blank = (c) => (c === '\n' ? '\n' : ' ');
  let out = '';
  let quote = null;
  let lastValue = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < text.length) { out += next; i += 2; continue; }
      if (c === quote) quote = null;
      else if (c === '\n' && quote !== '`') quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; lastValue = c; i += 1; continue; }
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i += 1; } continue; }
    if (c === '/' && next === '*') {
      out += '  '; i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { out += blank(text[i]); i += 1; }
      if (i < text.length) { out += '  '; i += 2; }
      continue;
    }
    if (c === '/' && !VALUE_ENDS.test(lastValue)) {
      out += c; i += 1;
      let inClass = false;
      while (i < text.length && text[i] !== '\n') {
        const r = text[i];
        out += r;
        i += 1;
        if (r === '\\') { if (i < text.length) { out += text[i]; i += 1; } continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
      }
      lastValue = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastValue = c;
    i += 1;
  }
  return out;
}
