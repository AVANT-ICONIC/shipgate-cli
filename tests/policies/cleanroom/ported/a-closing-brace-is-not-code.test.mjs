import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';

// A WINDOW THAT IS MOSTLY PUNCTUATION IS NOT A COPIED BLOCK.
//
// The window filter counted any non-empty normalized line as content, and `},`,
// `});` and `}` are non-empty. Two functions ending beside the same one-line
// call therefore read as eight duplicated lines.
//
// MEASURED 2026-09-17 in apex-nexus: five browser instruments were consolidated
// onto one shared module. 36 duplicate blocks went to zero and this shape was
// what remained -- three closing lines, a blank, and the three lines that call
// the shared module. The rule's own advice, consolidate into one
// implementation, had already been taken.

const blocks = (root) => scan(root, loadConfig(root)).violations.filter((v) => v.rule === 'duplication/block');

function repo(files) {
  const root = tempRepo();
  initialize(root, { existing: true });
  for (const [rel, body] of Object.entries(files)) put(root, rel, body);
  return root;
}

/**
 * Two tools whose own code differs, ending beside the same shared call.
 *
 * The overlap is exactly eight lines and six of them are punctuation or blank:
 * `},` `});` `}` blank, then the three that call the shared module, then blank.
 * This is the shape apex-nexus was left with after its five browser
 * instruments were consolidated onto one module.
 */
const first = `import { openInstrument } from './shared.js';

function parseArgs(argv) {
  return configure(argv, {
    flag(a, argv, i) {
      const v = argv[i];
      if (v === '--count') { a.counts.push(argv[i + 1]); return i + 1; }
      if (v === '--expect') { a.expect.push(argv[i + 1]); return i + 1; }
      if (v === '--press') { a.steps.push({ kind: 'press', key: argv[i + 1] }); return i + 1; }
      return null;
    },
  });
}

async function main() {
  const { args, chrome, port, profileDir, teardown, guard, deadline } =
    await openInstrument({ parse: parseArgs, label: 'first', profilePrefix: 'a-' });

  const report = { counts: {}, texts: {}, evals: {}, consoleErrors: [] };
  return read(args, chrome, port, profileDir, teardown, guard, deadline, report);
}
`;

const second = `import { openInstrument } from './shared.js';

function parseArgs(argv) {
  return configure(argv, {
    defaults: { duration: 10000 },
    flag(a, argv, i) {
      if (argv[i] !== '--duration') return null;
      a.duration = Number(argv[i + 1]);
      return i + 1;
    },
  });
}

async function main() {
  const { args, chrome, port, profileDir, teardown, guard, deadline } =
    await openInstrument({ parse: parseArgs, label: 'second', profilePrefix: 'b-' });

  const trace = { longTasks: [], forcedLayouts: 0, styleRecalcs: 0, paints: 0 };
  return profile(args, chrome, port, profileDir, teardown, guard, deadline, trace);
}
`;

test('two tools calling the same shared helper is not a duplicated block', () => {
  const root = repo({
    'src/shared.js': 'export function openInstrument() { return {}; }\n',
    'src/first.js': first,
    'src/second.js': second,
  });
  assert.deepEqual(blocks(root).map((v) => v.message), [],
    'the consolidation this rule asks for must not itself be a violation');
});

test('THE INVERTED CONTROL: eight lines of real copied code is still a block', () => {
  // Without this the test above would pass against a rule that had been turned
  // off, which is the whole failure mode.
  const copied = `export function work(input) {
  const rows = input.split('\\n');
  const kept = [];
  for (const row of rows) {
    const trimmed = row.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    kept.push(trimmed.toLowerCase());
  }
  const unique = [...new Set(kept)].sort();
  return { rows: rows.length, kept: kept.length, unique };
}
`;
  const root = repo({ 'src/one.js': copied, 'src/two.js': copied.replace('export function work', 'export function toil') });
  assert.ok(blocks(root).length > 0, 'a real copy must still be reported');
});

test('a block of nothing but braces is never a finding, however long', () => {
  const braces = 'function a() {\n  if (x) {\n    while (y) {\n      do {\n      } while (z);\n    }\n  }\n}\n';
  const root = repo({ 'src/a.js': braces, 'src/b.js': braces.replace('function a', 'function b') });
  assert.deepEqual(blocks(root).map((v) => v.message), []);
});
