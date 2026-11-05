// Test harness (not a test): runs the pinned legacy cli.mjs with process.exit
// patched to RECORD the exit code and the exact cli.mjs line that invoked it,
// then rethrows so no code after a legacy exit site ever executes. The site
// list is written as JSON to the file named by OBSERVE_OUT.
//
// Legacy flow note: every ordinary exit site sits inside the cli's try block,
// so the recorded sequence is [realSite, catchSite] (the trip is caught, the
// catch banner is swallowed below, and the catch's own exit is recorded). A
// genuine catch-path run records only [catchSite]. The observed site is
// always sites[0].
import { writeFileSync } from "node:fs";

const [cli, ...args] = process.argv.slice(2);
process.argv = [process.argv[0], cli, ...args];

const TRIP = "__EXIT_TRIP__";
const sites = [];
const originalError = console.error;
console.error = (...parts) => {
  if (String(parts[0]).includes(TRIP)) return; // swallow the synthetic catch banner
  originalError(...parts);
};
process.exit = (code) => {
  const match = String(new Error().stack).match(/cli\.mjs:(\d+)/);
  sites.push({ code, line: match ? Number(match[1]) : null });
  throw new Error(TRIP);
};

try {
  await import(cli);
} catch (error) {
  if (!String(error && error.message).includes(TRIP)) throw error;
}
writeFileSync(process.env.OBSERVE_OUT, JSON.stringify(sites));
