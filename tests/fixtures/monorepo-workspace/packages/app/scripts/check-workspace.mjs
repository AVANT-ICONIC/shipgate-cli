import { existsSync } from "node:fs";

if (!existsSync("../../root-marker.txt")) {
  console.error("workspace root marker is missing");
  process.exit(1);
}

if (!existsSync("../../pnpm-workspace.yaml")) {
  console.error("workspace manifest is missing");
  process.exit(1);
}

console.log("workspace root available from package verification");
