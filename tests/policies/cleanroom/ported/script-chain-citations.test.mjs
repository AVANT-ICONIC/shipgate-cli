import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';
import { codeWithoutComments } from '../../../../src/policies/cleanroom/lib/fs.mjs';

// A CITATION IS NOT AN INVOCATION.
//
// `scripts/chain` searched a script's whole text for another script's path. A
// codebase that explains itself names its own files constantly -- "see
// scripts/x.mjs", "MEASURED by scripts/y.mjs" -- and every one of those was
// reported as a chain.
//
// MEASURED 2026-09-17 in apex-nexus: 78 chain violations, 37 of them a file
// name inside a comment. Nearly half the rule's output convicted the repository
// of writing down what it did, and the real chains were buried underneath.

const chains = (root) => scan(root, loadConfig(root)).violations.filter((v) => v.rule === 'scripts/chain');
const messages = (root) => chains(root).map((v) => v.message);

function repo() {
  const root = tempRepo();
  initialize(root, { existing: true });
  put(root, 'scripts/worker.mjs', 'export const work = () => 1;\n');
  return root;
}

test('a script named only in a comment is a citation, and not a chain', () => {
  const root = repo();
  put(root, 'scripts/caller.mjs', [
    '// The measurement behind this number was taken by scripts/worker.mjs.',
    '/* See also scripts/worker.mjs for the reasoning. */',
    'export const n = 1;',
    ''
  ].join('\n'));
  assert.deepEqual(messages(root).filter((m) => m.includes('caller.mjs')), []);
});

test('THE INVERTED CONTROL: the same path in live code is still a chain', () => {
  // Without this the test above would pass against a rule that had been turned
  // off entirely, which is the failure this whole change exists to avoid.
  const root = repo();
  put(root, 'scripts/caller.mjs', [
    "import { spawnSync } from 'node:child_process';",
    "spawnSync('node', ['scripts/worker.mjs']);",
    ''
  ].join('\n'));
  assert.ok(messages(root).some((m) => m.includes('scripts/caller.mjs -> scripts/worker.mjs')),
    `expected the spawn to be caught, got ${JSON.stringify(messages(root))}`);
});

test('an import is reported as an import, not as an invocation', () => {
  // Both branches fingerprint the edge identically, so the scanner keeps one.
  // Before this the text branch always won and said "invokes another script
  // path" about a plain import statement.
  const root = repo();
  put(root, 'scripts/caller.mjs', "import { work } from './worker.mjs';\nexport const n = work();\n");
  const found = messages(root).filter((m) => m.includes('caller.mjs'));
  assert.equal(found.length, 1, `one edge, one violation: ${JSON.stringify(found)}`);
  assert.match(found[0], /imports another script/);
});

test('a comment beside a real import does not turn one edge into two', () => {
  const root = repo();
  put(root, 'scripts/caller.mjs', [
    '// scripts/worker.mjs holds the reasoning.',
    "import { work } from './worker.mjs';",
    'export const n = work();',
    ''
  ].join('\n'));
  const found = chains(root).filter((v) => v.paths.includes('scripts/caller.mjs'));
  assert.equal(found.length, 1);
  assert.match(found[0].message, /imports another script/);
});

// ---------------------------------------------------------------------------
// The stripper, on the forms that actually appear in source.

test('a // inside a string is not a comment', () => {
  assert.match(codeWithoutComments("const u = 'https://example.com/a.mjs';"), /https:\/\/example\.com\/a\.mjs/);
});

test('a /* inside a string is not a comment', () => {
  assert.match(codeWithoutComments("const g = '/*.mjs'; const after = 1;"), /after/);
});

test('a regex holding a quote does not swallow the rest of the file', () => {
  // `/['"]/` is ordinary in a parser. Read as an opening quote it would hide
  // every line after it, and the rule would go quiet without saying so.
  const code = codeWithoutComments("const q = /['\"]/; const target = 'scripts/worker.mjs';");
  assert.match(code, /scripts\/worker\.mjs/);
});

test('a // inside a regex is not a comment either', () => {
  assert.match(codeWithoutComments('const r = /a\\/\\/b/; const after = 1;'), /after/);
});

test('division is not mistaken for a regex', () => {
  assert.match(codeWithoutComments('const half = total / 2; const after = 1;'), /after/);
});

test('comments become blanks, so every line still lands where it did', () => {
  const source = 'const a = 1; // note\n/* two\n   lines */\nconst b = 2;\n';
  const stripped = codeWithoutComments(source);
  assert.equal(stripped.split('\n').length, source.split('\n').length);
  assert.equal(stripped.split('\n')[3], 'const b = 2;');
  assert.doesNotMatch(stripped, /note|lines/);
});

test('a template literal keeps its contents and may cross lines', () => {
  const code = codeWithoutComments('const t = `a\n// not a comment\nb`;\nconst after = 1;');
  assert.match(code, /not a comment/);
  assert.match(code, /after/);
});

test('an unterminated quote costs one line and never the rest of the file', () => {
  const code = codeWithoutComments("const bad = 'oops\nconst target = 'scripts/worker.mjs';");
  assert.match(code, /scripts\/worker\.mjs/);
});

test('nothing but a string is accepted, and anything else is empty', () => {
  for (const bad of [null, undefined, 42, {}, []]) assert.equal(codeWithoutComments(bad), '');
});
