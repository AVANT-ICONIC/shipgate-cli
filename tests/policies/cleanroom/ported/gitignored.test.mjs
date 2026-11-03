import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tempRepo, put } from './helpers.mjs';
import { walk, sourceFiles, gitIgnoredPaths } from '../../../../src/policies/cleanroom/lib/fs.mjs';

// A PROJECT'S .gitignore IS THE AUTHORITY ON WHAT IS NOT ITS SOURCE.
//
// The walker knew only the `ignore` list, which is a hand-written
// approximation of one: node_modules, dist, build, .next, coverage, .turbo,
// .cache, vendor, target. Anything a project ignores that is not on that list
// was scanned as if the project had written it.
//
// MEASURED 2026-09-17 in apex-nexus: `.apex/` is gitignored scratch holding two
// vendored checkouts, and Green Room reported 75 NEW structural violations
// against them -- cycles, trivial wrappers and script chains inside somebody
// else's code. `greenroom check` was BLOCKED in the working checkout and PASSED
// in a clean worktree of the same commit, because the untracked scratch existed
// in one and not the other. A gate whose verdict depends on what is lying
// around beside the repository is not a gate.

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/** A real repository, because this feature IS the interaction with git. */
function repoWithIgnoredScratch() {
  const root = tempRepo();
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  put(root, '.gitignore', '.scratch/\nbuilt.js\n');
  put(root, 'src/own.js', 'export const own = 1;\n');
  put(root, '.scratch/vendored/theirs.js', 'export const theirs = 1;\n');
  put(root, '.scratch/vendored/deep/more.js', 'export const more = 1;\n');
  put(root, 'built.js', 'export const built = 1;\n');
  git(root, 'add', '.gitignore', 'src/own.js');
  git(root, 'commit', '-qm', 'initial');
  return root;
}

const config = { ignore: ['.git'], ignorePatterns: [], maxFileBytes: 0 };
const rels = (root, cfg = config) => walk(root, cfg).map((f) => f.rel).sort();

test('a gitignored directory is not scanned, however deep it goes', () => {
  const root = repoWithIgnoredScratch();
  const found = rels(root);
  assert.ok(found.includes('src/own.js'), 'the project\'s own source must still be scanned');
  assert.deepEqual(found.filter((f) => f.startsWith('.scratch/')), [],
    'a vendored checkout the project ignores is not the project\'s code');
  assert.equal(found.includes('built.js'), false, 'an ignored FILE is skipped too, not only a directory');
});

test('the same tree with respectGitignore:false scans it, so the guard is proved to act', () => {
  // An inverted control. Without it this file would pass against a walker that
  // never looked at git at all, as long as something else happened to skip the
  // scratch.
  const root = repoWithIgnoredScratch();
  const found = rels(root, { ...config, respectGitignore: false });
  assert.ok(found.some((f) => f.startsWith('.scratch/')),
    'opting out must actually scan the ignored tree — otherwise the default proves nothing');
  assert.ok(found.includes('built.js'));
});

test('a directory that is NOT ignored is still scanned, so this is not a blanket skip', () => {
  const root = repoWithIgnoredScratch();
  put(root, 'tools/helper.js', 'export const helper = 1;\n');
  assert.ok(rels(root).includes('tools/helper.js'));
});

test('an untracked file that git does not ignore is still scanned', () => {
  // Untracked is not ignored. Work in progress is the project's code and has to
  // be judged, or the gate would go quiet exactly while a change is being made.
  const root = repoWithIgnoredScratch();
  put(root, 'src/brand-new.js', 'export const fresh = 1;\n');
  assert.ok(rels(root).includes('src/brand-new.js'));
});

test('sourceFiles inherits the same rule, since every analyzer goes through it', () => {
  const root = repoWithIgnoredScratch();
  const found = sourceFiles(root, config).map((f) => f.rel);
  assert.ok(found.includes('src/own.js'));
  assert.deepEqual(found.filter((f) => f.startsWith('.scratch/')), []);
});

test('a directory that is not a git repository walks exactly as it always did', () => {
  // No git, no repository, git not installed, git failing for its own reasons:
  // all four are the same answer, and none of them may turn the walker off.
  const root = tempRepo();
  put(root, 'src/own.js', 'export const own = 1;\n');
  put(root, 'anything/at/all.js', 'export const all = 1;\n');
  assert.deepEqual(rels(root), ['anything/at/all.js', 'src/own.js']);
  assert.deepEqual([...gitIgnoredPaths(root)], [], 'outside a repository nothing is ignored, and nothing throws');
});

test('gitIgnoredPaths collapses a vendored tree to one entry rather than thousands', () => {
  // `--directory` is what keeps this affordable: a 300 MB vendored checkout
  // costs one line, not one line per file.
  const root = repoWithIgnoredScratch();
  const ignored = gitIgnoredPaths(root);
  assert.ok(ignored.has('.scratch'), `expected .scratch, got ${[...ignored].join(', ')}`);
  assert.equal(ignored.has('.scratch/vendored/deep/more.js'), false, 'the tree is collapsed, not enumerated');
  assert.ok(ignored.has('built.js'), 'an ignored file is named on its own');
});

test('the trailing slash git prints on a directory is stripped, or nothing would ever match', () => {
  // `git ls-files --directory` prints `.scratch/`, and the walker compares
  // against `.scratch`. Off by one slash is a guard that silently never fires.
  const root = repoWithIgnoredScratch();
  for (const entry of gitIgnoredPaths(root)) {
    assert.doesNotMatch(entry, /\/$/, `${entry} still carries its trailing slash`);
  }
});
