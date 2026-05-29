import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

async function readProjectFile(file: string): Promise<string> {
  return readFile(path.join(root, file), "utf8");
}

describe("CI examples", () => {
  it("runs fresh verification in every example", async () => {
    const files = [
      "docs/CI.md",
      "examples/ci/github-actions.yml",
      "examples/ci/gitlab-ci.yml"
    ];

    for (const file of files) {
      await expect(readProjectFile(file)).resolves.toContain("shipgate verify --fresh");
    }
  });

  it("preserves ShipGate reports and repair prompts as artifacts", async () => {
    const github = await readProjectFile("examples/ci/github-actions.yml");
    const gitlab = await readProjectFile("examples/ci/gitlab-ci.yml");

    for (const content of [github, gitlab]) {
      expect(content).toContain(".shipgate/latest-report.md");
      expect(content).toContain(".shipgate/latest-result.json");
      expect(content).toContain(".shipgate/latest-repair-prompt.md");
      expect(content).toContain(".shipgate/artifacts");
    }
  });
});
