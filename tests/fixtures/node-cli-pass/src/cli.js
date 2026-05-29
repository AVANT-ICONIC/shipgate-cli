#!/usr/bin/env node
if (process.argv.includes("--help")) {
  console.log("Usage: passing-cli [options]");
  process.exit(0);
}

console.log("passing-cli");
