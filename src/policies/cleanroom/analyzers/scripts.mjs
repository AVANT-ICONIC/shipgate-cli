// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path';
import { readJson, readText, isInsideAny, walk, codeWithoutComments } from '../lib/fs.mjs';
import { violation } from '../violations.mjs';
import { buildGraph } from './imports.mjs';

function normalizedScriptPath(value) { return value.replace(/^\.\//, '').replaceAll('\\', '/'); }

// A PATH ENDS WHERE A PATH ENDS.
//
// The text branch below asks whether a script's code names another script's
// path. Two scripts in the same directory make that path a bare file name, and
// a plain substring test then matches any longer path ending in the same
// characters: `packages/runtime/src/worker.mjs` answers a search for
// `worker.mjs`. MEASURED 2026-09-18 in apex-nexus: extracting a tools/ script
// into packages/ was reported as a chain to the very file the extraction had
// just stopped chaining to, and the work had to rename the new module to land.
// Renaming code to satisfy a detector is the opposite of what this rule is for.
//
// So a mention counts only where the character before it cannot continue a
// path. Nothing here narrows what the rule catches: every variant the caller
// builds is still searched, and a sibling named bare, as ./name, or by its
// full path from the root all still match.
const PATH_CHARACTER = /[A-Za-z0-9_.\-/]/;
function mentionsPath(text, candidate) {
  if (!candidate) return false;
  let from = 0;
  for (;;) {
    const at = text.indexOf(candidate, from);
    if (at === -1) return false;
    if (at === 0 || !PATH_CHARACTER.test(text[at - 1])) return true;
    from = at + 1;
  }
}
function lifecycleAllowed(name, ref, config) {
  if (!config.scripts.allowLifecycleHooks) return false;
  return name === `pre${ref}` || name === `post${ref}`;
}

function packageScriptViolations(root, config) {
  const out = [];
  const packages = walk(root, config).filter((f) => path.basename(f.rel) === 'package.json');
  if (!packages.some((f) => f.rel === 'package.json')) packages.unshift({ rel: 'package.json', abs: path.join(root, 'package.json') });
  const allowedPackage = new Set(config.scripts.allowPackageChains || []);
  for (const pkgFile of packages) {
    const pkg = readJson(pkgFile.abs, null);
    if (!pkg || typeof pkg !== 'object') continue;
    const scripts = pkg.scripts || {};
    for (const [name, cmd] of Object.entries(scripts)) {
      const refs = [...String(cmd).matchAll(/(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:-]+)/g)].map((m) => m[1]);
      for (const ref of refs) {
        const edge = `${name}->${ref}`;
        if (scripts[ref] && !lifecycleAllowed(name, ref, config) && !allowedPackage.has(edge) && !allowedPackage.has(`${pkgFile.rel}:${edge}`)) {
          out.push(violation('scripts/chain', [pkgFile.rel], `Package script "${name}" chains to "${ref}" in ${pkgFile.rel}`, `${pkgFile.rel}:${edge}`));
        }
      }
    }
  }
  return out;
}

export function analyzeScripts(root, files, config) {
  if (!config.rules.scriptChains) return [];
  const out = [];
  const scriptFiles = files.filter((f) => isInsideAny(f.rel, config.scriptRoots || []));
  const scriptSet = new Set(scriptFiles.map((f) => f.rel));
  const graph = buildGraph(root, files);
  const allowed = new Set(config.scripts.allowScriptImports || []);
  for (const f of scriptFiles) {
    // AN IMPORT IS A KNOWN EDGE, NOT A GUESS, SO IT IS REPORTED AS ONE.
    //
    // Both branches below fingerprint an edge the same way, so before this the
    // text branch overwrote the import branch in the scanner's de-duplication
    // and every genuine import was reported as "invokes another script path".
    // MEASURED 2026-09-17 in apex-nexus: 78 chain violations, none of which
    // said "imports", while 40 of them were plain `import ... from './x.mjs'`.
    const imported = new Set([...(graph.get(f.rel) || [])].filter((dep) => scriptSet.has(dep)));
    for (const dep of imported) {
      if (!allowed.has(`${f.rel}->${dep}`)) out.push(violation('scripts/chain', [f.rel, dep], `Script imports another script: ${f.rel} -> ${dep}`, `${f.rel}->${dep}`));
    }
    // Comments are stripped first: a path named in prose is a citation, and
    // convicting a file for documenting where a number came from is noise that
    // buries the real chains. See codeWithoutComments.
    const text = codeWithoutComments(readText(f.abs));
    for (const target of scriptSet) {
      if (target === f.rel || imported.has(target)) continue;
      const bareTarget = normalizedScriptPath(target);
      const relativeFromScript = normalizedScriptPath(path.posix.relative(path.posix.dirname(f.rel), target));
      const variants = new Set([bareTarget, `./${bareTarget}`, relativeFromScript, `./${relativeFromScript}`]);
      if ([...variants].some((candidate) => mentionsPath(text, candidate)) && !allowed.has(`${f.rel}->${target}`)) out.push(violation('scripts/chain', [f.rel, target], `Script invokes another script path: ${f.rel} -> ${target}`, `${f.rel}->${target}`));
    }
  }
  out.push(...packageScriptViolations(root, config));
  return out;
}
