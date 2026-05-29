import { writeFileSync } from "node:fs";

const [file, value] = process.argv.slice(2);

if (!file || !value) {
  console.error("usage: node scripts/write-marker.mjs <file> <value>");
  process.exit(1);
}

writeFileSync(file, value);
console.log(`wrote ${file}`);
