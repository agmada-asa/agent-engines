/**
 * @file Regenerates the Codex app-server bindings in `src/codex/protocol/`, only
 * from the CLI version pinned in `src/codex/protocol/version.ts`.
 *
 * Bump `CODEX_PROTOCOL_VERSION` first, then run `npm run generate:protocol`.
 * Only files the source imports, and the files they reference, are kept, and
 * relative imports get a `.ts` extension so the bindings compile under NodeNext
 * and ship in `dist/`. Review the diff and the transport before committing
 * regenerated bindings.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const protocolDirectory = fileURLToPath(new URL("../src/codex/protocol/", import.meta.url));
const versionSource = readFileSync(new URL("../src/codex/protocol/version.ts", import.meta.url), "utf8");
const expectedVersion = readPinnedVersion(versionSource);
const installedVersion = readInstalledVersion();

if (installedVersion !== expectedVersion) {
  throw new Error(`Refusing to regenerate ${expectedVersion} bindings with Codex CLI ${installedVersion}.`);
}


/** Reads the protocol version constant that governs runtime compatibility. */
function readPinnedVersion(source) {
  const match = source.match(/CODEX_PROTOCOL_VERSION\s*=\s*"([^"]+)"/u);
  if (!match) throw new Error("Could not read CODEX_PROTOCOL_VERSION from src/codex/protocol/version.ts.");
  return match[1];
}

/** Reads the installed Codex CLI version from its stable --version output. */
function readInstalledVersion() {
  const output = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
  const match = output.match(/^codex-cli\s+(\S+)$/u);
  if (!match) throw new Error(`Unrecognized Codex CLI version output: ${output}`);
  return match[1];
}

/** Lists the TypeScript files under `current`, as `/`-separated paths relative to it. */
async function listFiles(current, prefix = "") {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(resolve(current, entry.name), relativePath));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(relativePath);
  }
  return files;
}

/**
 * The protocol files the hand-written source imports, read from its import
 * statements, so a new import is kept on the next run without a list to update.
 */
async function sourceRoots() {
  const roots = new Set();
  for (const file of await listFiles(sourceDirectory)) {
    if (file.startsWith("codex/protocol/")) continue;
    const source = readFileSync(resolve(sourceDirectory, file), "utf8");
    for (const [, imported] of source.matchAll(/from\s+"[^"]*\/protocol\/([^"]+\.ts)"/gu)) roots.add(imported);
  }
  return roots;
}

/** Keeps the files reachable from `roots` and adds `.ts` to their relative imports. */
async function pruneAndFixBindings(directory, roots) {
  const used = new Set(["version.ts"]);

  /** Walks generated imports recursively to retain every referenced protocol type. */
  function visit(relativePath) {
    if (used.has(relativePath)) return;
    used.add(relativePath);
    const sourcePath = resolve(directory, relativePath);
    const source = readFileSync(sourcePath, "utf8");
    for (const [, imported] of source.matchAll(/from\s+"((?:\.\.\/|\.\/).+?)(?:\.ts)?"/gu)) {
      const importedPath = relative(directory, resolve(dirname(sourcePath), `${imported}.ts`)).split(sep).join("/");
      visit(importedPath);
    }
  }

  for (const root of roots) visit(root);
  const files = await listFiles(directory);
  await Promise.all(files.filter((file) => !used.has(file)).map((file) => rm(resolve(directory, file))));
  // index.ts files re-export everything; they were removed above unless reachable.
  for (const file of used) {
    if (file === "version.ts") continue;
    const path = resolve(directory, file);
    const source = readFileSync(path, "utf8");
    writeFileSync(path, source.replace(/from\s+"((?:\.\.\/|\.\/)[^"]+?)(?<!\.ts)"/gu, 'from "$1.ts"'));
  }
}

const roots = await sourceRoots();
execFileSync("codex", ["app-server", "generate-ts", "--experimental", "--out", protocolDirectory], { stdio: "inherit" });
await pruneAndFixBindings(protocolDirectory, roots);
