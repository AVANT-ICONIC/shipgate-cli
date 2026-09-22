import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempRepo, put } from './helpers.mjs';
import { classifyRegistryDiff } from '../../../../src/policies/cleanroom/registry-diff.mjs';
import { integrityViolations } from '../../../../src/policies/cleanroom/integrity.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { registryHash } from '../../../../src/policies/cleanroom/integrity.mjs';

// ADDING A RESPONSIBILITY IS THE WORK. CHANGING ONE IS A DECISION.
//
// `policy/registry-changed` compared bytes, so the only way to populate an
// empty registry was GREENROOM_ALLOW_GOVERNANCE_UPDATE=1 -- a flag that
// switches the policy, waiver, registry and generated guards off together.
//
// MEASURED 2026-09-17 in apex-nexus: the registry is empty and 532 files need
// declaring, about 34 pull requests. A rule that makes a project disable four
// guards to do its routine work has inverted itself.

function git(root, ...args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

const REG = '.greenroom/registry.json';
const write = (root, value) => put(root, REG, JSON.stringify(value, null, 2) + '\n');

/** A real repository with a real base branch, because this feature IS git. */
function repoOnBase(baseRegistry) {
  const root = tempRepo();
  git(root, 'init', '-q', '-b', 'master');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  put(root, '.greenroom.json', JSON.stringify({ version: 1, registryFile: REG }, null, 2));
  put(root, 'src/a.js', 'export const a = 1;\n');
  put(root, 'src/b.js', 'export const b = 1;\n');
  write(root, baseRegistry);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  return root;
}

const EMPTY = { version: 1, responsibilities: {}, components: {} };
const ONE = {
  version: 1,
  responsibilities: { alpha: { canonical: 'src/a.js', owner: 'apex' } },
  components: {}
};

const ids = (root, baseline = null) =>
  integrityViolations(root, loadConfig(root), baseline, { compareRef: 'master' }).map((v) => v.rule);

// ---------------------------------------------------------------------------
// The classifier, on its own.

test('an entry that did not exist is an addition', () => {
  const d = classifyRegistryDiff(JSON.stringify(EMPTY), JSON.stringify(ONE));
  assert.equal(d.kind, 'additive');
  assert.deepEqual(d.added, ['responsibilities.alpha']);
  assert.deepEqual(d.changed, []);
  assert.deepEqual(d.removed, []);
});

test('rewriting what an existing entry owns is a mutation', () => {
  const moved = { ...ONE, responsibilities: { alpha: { canonical: 'src/b.js', owner: 'apex' } } };
  const d = classifyRegistryDiff(JSON.stringify(ONE), JSON.stringify(moved));
  assert.equal(d.kind, 'mutating');
  assert.deepEqual(d.changed, ['responsibilities.alpha']);
});

test('deleting an entry is a mutation, and is never read as an addition', () => {
  const two = { ...ONE, responsibilities: { ...ONE.responsibilities, beta: { canonical: 'src/b.js' } } };
  const d = classifyRegistryDiff(JSON.stringify(two), JSON.stringify(ONE));
  assert.equal(d.kind, 'mutating');
  assert.deepEqual(d.removed, ['responsibilities.beta']);
});

test('adding one while quietly editing another is a mutation, not a mixed pass', () => {
  // The obvious way to smuggle a rewrite past an additive rule.
  const sneaky = {
    version: 1,
    responsibilities: { alpha: { canonical: 'src/b.js' }, beta: { canonical: 'src/a.js' } },
    components: {}
  };
  const d = classifyRegistryDiff(JSON.stringify(ONE), JSON.stringify(sneaky));
  assert.equal(d.kind, 'mutating');
  assert.deepEqual(d.added, ['responsibilities.beta']);
  assert.deepEqual(d.changed, ['responsibilities.alpha']);
});

test('a top-level field outside the two entry bags is policy, and moving it mutates', () => {
  const bumped = { ...ONE, version: 2 };
  assert.equal(classifyRegistryDiff(JSON.stringify(ONE), JSON.stringify(bumped)).kind, 'mutating');
  const extra = { ...ONE, strictMode: true };
  assert.equal(classifyRegistryDiff(JSON.stringify(ONE), JSON.stringify(extra)).kind, 'mutating');
});

test('reordering keys and reformatting is not a change', () => {
  const reordered = {
    components: {},
    responsibilities: { alpha: { owner: 'apex', canonical: 'src/a.js' } },
    version: 1
  };
  assert.equal(classifyRegistryDiff(JSON.stringify(ONE, null, 2), JSON.stringify(reordered)).kind, 'same');
});

test('components are held to the same rule as responsibilities', () => {
  const withComponent = { ...EMPTY, components: { card: { canonical: 'src/a.js' } } };
  assert.equal(classifyRegistryDiff(JSON.stringify(EMPTY), JSON.stringify(withComponent)).kind, 'additive');
  const movedComponent = { ...EMPTY, components: { card: { canonical: 'src/b.js' } } };
  assert.equal(classifyRegistryDiff(JSON.stringify(withComponent), JSON.stringify(movedComponent)).kind, 'mutating');
});

test('unreadable is its own answer and never collapses into additive', () => {
  for (const bad of ['', '   ', '{not json', '[]', 'null', '"a string"', null, undefined, 42]) {
    assert.equal(classifyRegistryDiff(bad, JSON.stringify(ONE)).kind, 'unreadable', `previous ${JSON.stringify(bad)}`);
    assert.equal(classifyRegistryDiff(JSON.stringify(ONE), bad).kind, 'unreadable', `current ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// And what the gate does with it. Both paths: the branch comparison and the
// baseline hash.

test('declaring a new responsibility does not raise a governance violation', () => {
  const root = repoOnBase(EMPTY);
  write(root, ONE);
  assert.deepEqual(ids(root).filter((r) => r === 'policy/registry-changed'), []);
});

test('THE INVERTED CONTROL: rewriting an existing entry still raises it', () => {
  // Without this the test above would pass against a gate that had simply
  // stopped checking the registry at all.
  const root = repoOnBase(ONE);
  write(root, { ...ONE, responsibilities: { alpha: { canonical: 'src/b.js' } } });
  assert.ok(ids(root).includes('policy/registry-changed'), 'a moved canonical path is an architecture change');
});

test('deleting an entry still raises it', () => {
  const root = repoOnBase(ONE);
  write(root, EMPTY);
  assert.ok(ids(root).includes('policy/registry-changed'));
});

test('the baseline-hash path agrees with the branch path on the same edit', () => {
  // Two independent checks fire on a registry change. If only one learned the
  // difference, an additive PR would still be blocked by the other.
  const root = repoOnBase(EMPTY);
  const config = loadConfig(root);
  const staleHash = registryHash(root, config);
  write(root, ONE);
  const baseline = { registryHash: staleHash };
  assert.notEqual(registryHash(root, config), staleHash, 'the hash really did move');
  assert.deepEqual(ids(root, baseline).filter((r) => r === 'policy/registry-changed'), [],
    'the hash check must not block what the branch check allowed');
});

test('the baseline-hash path still blocks a rewrite', () => {
  const root = repoOnBase(ONE);
  const config = loadConfig(root);
  const staleHash = registryHash(root, config);
  write(root, { ...ONE, responsibilities: { alpha: { canonical: 'src/b.js' } } });
  assert.ok(ids(root, { registryHash: staleHash }).includes('policy/registry-changed'));
});

test('with no base ref to read, an additive edit is NOT waved through', () => {
  // Fail closed. We cannot classify what we cannot read, and an unclassified
  // registry edit is a governance event.
  const root = repoOnBase(EMPTY);
  const config = loadConfig(root);
  const staleHash = registryHash(root, config);
  write(root, ONE);
  const found = integrityViolations(root, config, { registryHash: staleHash }, { compareRef: null })
    .map((v) => v.rule);
  assert.ok(found.includes('policy/registry-changed'), 'no reference, no exemption');
});

test('an unreadable registry on disk refuses to answer rather than passing', () => {
  // A registry we cannot parse is not a registry we have judged additive. The
  // gate already refuses outright here, which is the answer that claims least,
  // and the exemption must not turn that refusal into a pass.
  const root = repoOnBase(EMPTY);
  fs.writeFileSync(path.join(root, REG), '{ broken');
  const config = loadConfig(root);
  assert.throws(
    () => integrityViolations(root, config, { registryHash: 'stale' }, { compareRef: 'master' }),
    /Invalid JSON/,
    'a broken registry must stop the run, never be waved through as additive'
  );
  // And the classifier that the exemption rests on says the same on its own.
  assert.equal(classifyRegistryDiff(JSON.stringify(EMPTY), '{ broken').kind, 'unreadable');
});

test('the other three governance guards are untouched by this', () => {
  // The exemption is scoped to one file. A policy, waiver or generated change
  // must behave exactly as it did.
  const root = repoOnBase(EMPTY);
  write(root, ONE);
  fs.writeFileSync(path.join(root, '.greenroom.json'),
    JSON.stringify({ version: 1, registryFile: REG, maxFileBytes: 2048 }, null, 2));
  const found = ids(root);
  assert.ok(found.includes('policy/config-changed'), 'a policy edit is still a governance event');
  assert.deepEqual(found.filter((r) => r === 'policy/registry-changed'), []);
});
