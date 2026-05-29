#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execaCommand } from "execa";

const repo = process.env.SHIPGATE_RELEASE_REPO ?? "AVANT-ICONIC/shipgate-cli";
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const version = packageJson.version;
const tag = `v${version}`;
const packageName = `shipgate-cli-${version}.tgz`;
const tmp = await mkdtemp(path.join(tmpdir(), "shipgate-release-"));
const installScriptPath = fileURLToPath(new URL("../install.sh", import.meta.url));
const githubEnv = process.env.SHIPGATE_GH_HOME
  ? { ...process.env, HOME: process.env.SHIPGATE_GH_HOME }
  : process.env;

async function run(command, env = process.env) {
  const result = await execaCommand(command, {
    shell: true,
    stdio: "inherit",
    env,
    reject: false
  });

  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${result.exitCode}): ${command}`);
  }
}

await mkdir(tmp, { recursive: true });
await run("shipgate verify --fresh");
await run("npm pack --dry-run");
await run(`npm pack --pack-destination ${JSON.stringify(tmp)}`);

const packagePath = path.join(tmp, packageName);
const digest = createHash("sha256")
  .update(await readFile(packagePath))
  .digest("hex");
const checksumPath = `${packagePath}.sha256`;
await writeFile(checksumPath, `${digest}  ${packageName}\n`, "utf8");

const notesPath = path.join(tmp, "release-notes.md");
await writeFile(notesPath, [
  `ShipGate CLI ${tag}`,
  "",
  "Tester prerelease distributed through GitHub Releases while npm publishing is unavailable.",
  "",
  "Install:",
  "",
  "```bash",
  `npm install -g https://github.com/${repo}/releases/download/${tag}/${packageName}`,
  "shipgate doctor",
  "```",
  "",
  "Verify the package checksum with the attached `.sha256` file."
].join("\n"), "utf8");

await run([
  "gh release create",
  tag,
  `${JSON.stringify(`${packagePath}#${packageName}`)}`,
  `${JSON.stringify(`${checksumPath}#${packageName}.sha256`)}`,
  `${JSON.stringify(`${installScriptPath}#install.sh`)}`,
  "--repo",
  repo,
  "--target",
  "main",
  "--title",
  JSON.stringify(`ShipGate CLI ${tag} tester release`),
  "--notes-file",
  JSON.stringify(notesPath),
  "--prerelease"
].join(" "), githubEnv);

console.log(`Published ${tag} to https://github.com/${repo}/releases/tag/${tag}`);
