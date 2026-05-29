import { readFileSync } from "node:fs";

const [file, expected] = process.argv.slice(2);

if (!file || !expected) {
  console.error("usage: node scripts/assert-marker.mjs <file> <expected>");
  process.exit(1);
}

const actual = readFileSync(file, "utf8");

if (actual !== expected) {
  console.error(`expected ${file} to contain ${expected}, got ${actual}`);
  process.exit(1);
}

console.log(`verified ${file}`);
