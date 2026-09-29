import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "./ported-source-sha256.json";

const portedSource = path.resolve("src/policies/cleanroom");
const spdx = "// SPDX-License-Identifier: AGPL-3.0-or-later\n";

async function files(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const rel = path.join(relative, entry.name);
    return entry.isDirectory() ? files(root, rel) : [rel];
  }));
  return nested.flat().filter((file) => file.endsWith(".mjs")).sort();
}

describe("verbatim Cleanroom port", () => {
  it("ports all 39 runtime modules with only the approved SPDX header added", async () => {
    const expectedFiles = Object.keys(manifest.files).sort();
    expect(expectedFiles).toHaveLength(39);
    expect(await files(portedSource)).toEqual(expectedFiles);
    for (const file of expectedFiles) {
      const ported = await readFile(path.join(portedSource, file), "utf8");
      expect(ported.startsWith(spdx)).toBe(true);
      const sourceBytes = ported.slice(spdx.length);
      expect(createHash("sha256").update(sourceBytes).digest("hex"))
        .toBe(manifest.files[file as keyof typeof manifest.files]);
    }
  });

  it("contains no process.exit call under src/policies", async () => {
    const policyFiles = await files(path.resolve("src/policies"));
    for (const file of policyFiles) {
      expect(await readFile(path.resolve("src/policies", file), "utf8")).not.toContain("process.exit(");
    }
  });
});
