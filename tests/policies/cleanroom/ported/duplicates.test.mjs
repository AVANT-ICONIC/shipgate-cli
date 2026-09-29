import { test } from 'vitest';
import assert from 'node:assert/strict';
import { tempRepo, put } from './helpers.mjs';
import { initialize } from '../../../../src/policies/cleanroom/init.mjs';
import { loadConfig } from '../../../../src/policies/cleanroom/config.mjs';
import { scan } from '../../../../src/policies/cleanroom/scanner.mjs';

const blockA = `
export function alpha(input) {
  const one = input.trim();
  const two = one.toLowerCase();
  const three = two.replace(/a/g, 'b');
  const four = three.split(',');
  const five = four.filter(Boolean);
  const six = five.map((value) => value.trim());
  return six.join('|');
}
`;
const blockB = `
export function beta(items) {
  const one = items.slice();
  const two = one.reverse();
  const three = two.filter(Boolean);
  const four = three.map((value) => String(value));
  const five = four.join(':');
  const six = five.toUpperCase();
  return six.trim();
}
`;

test('one long cloned region collapses overlapping sliding windows', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  put(root, 'src/a.ts', blockA);
  put(root, 'src/b.ts', blockA);
  const result = scan(root, loadConfig(root));
  const blocks = result.violations.filter((v) => v.rule === 'duplication/block');
  assert.equal(blocks.length, 1);
});

test('separate cloned regions in the same files remain separate findings', () => {
  const root = tempRepo(); initialize(root, { existing: true });
  const spacer = `\nexport const uniqueA = ${JSON.stringify('x'.repeat(240))};\n`;
  const spacer2 = `\nexport const uniqueB = ${JSON.stringify('y'.repeat(240))};\n`;
  put(root, 'src/a.ts', `${blockA}${spacer}${blockB}`);
  put(root, 'src/b.ts', `${blockA}${spacer2}${blockB}`);
  const result = scan(root, loadConfig(root));
  const blocks = result.violations.filter((v) => v.rule === 'duplication/block');
  assert.equal(blocks.length, 2);
});
