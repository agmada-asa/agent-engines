/**
 * @file Regenerates the Codex app-server bindings in `src/codex/protocol/`, only
 * from the CLI version pinned in `src/codex/protocol/version.ts`.
 *
 * Bump `CODEX_PROTOCOL_VERSION` first, then run `npm run generate:protocol`.
 * Only files reachable from the roots below are kept, and relative imports get
 * a `.ts` extension so the bindings compile under NodeNext and ship in `dist/`.
 * Review the diff and the transport before committing regenerated bindings.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * The protocol types `src/codex/` imports. Everything they reference is kept;
 * the rest of the (very large) generated tree is removed.
 */
const ROOTS = [
  "InitializeParams.ts", "InitializeResponse.ts", "RequestId.ts", "ReasoningEffort.ts",
  "v2/Model.ts", "v2/ModelListParams.ts", "v2/ModelListResponse.ts",
  "v2/GetAccountParams.ts", "v2/GetAccountResponse.ts", "v2/GetAccountRateLimitsResponse.ts",
  "v2/ThreadStartParams.ts", "v2/ThreadStartResponse.ts",
  "v2/ThreadResumeParams.ts", "v2/ThreadResumeResponse.ts",
  "v2/ThreadTurnsListParams.ts", "v2/ThreadTurnsListResponse.ts",
  "v2/ThreadDeleteParams.ts", "v2/ThreadCompactStartParams.ts",
  "v2/ThreadListParams.ts", "v2/ThreadListResponse.ts",
  "v2/TurnStartParams.ts", "v2/TurnStartResponse.ts",
  "v2/TurnSteerParams.ts", "v2/TurnSteerResponse.ts",
  "v2/TurnInterruptParams.ts",
  "v2/TurnStartedNotification.ts", "v2/TurnCompletedNotification.ts",
  "v2/ItemStartedNotification.ts", "v2/ItemCompletedNotification.ts",
  "v2/AgentMessageDeltaNotification.ts", "v2/ReasoningTextDeltaNotification.ts",
  "v2/ReasoningSummaryTextDeltaNotification.ts", "v2/ErrorNotification.ts",
  "v2/ThreadTokenUsageUpdatedNotification.ts", "v2/AccountRateLimitsUpdatedNotification.ts",
  "v2/ModelReroutedNotification.ts", "v2/ServerRequestResolvedNotification.ts",
  "v2/CommandExecutionRequestApprovalParams.ts", "v2/CommandExecutionRequestApprovalResponse.ts",
  "v2/FileChangeRequestApprovalParams.ts", "v2/FileChangeRequestApprovalResponse.ts",
  "v2/PermissionsRequestApprovalParams.ts", "v2/PermissionsRequestApprovalResponse.ts",
  "v2/ToolRequestUserInputParams.ts", "v2/ToolRequestUserInputResponse.ts",
  "v2/McpServerElicitationRequestParams.ts", "v2/McpServerElicitationRequestResponse.ts",
  "v2/DynamicToolCallParams.ts", "v2/DynamicToolCallResponse.ts",
  "v2/ListMcpServerStatusParams.ts", "v2/ListMcpServerStatusResponse.ts",
];

/** Keeps the reachable files and adds `.ts` to their relative imports. */
async function pruneAndFixBindings(directory) {
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

  /** Collects generated TypeScript files for pruning after the import graph is complete. */
  async function listFiles(current, prefix = "") {
    const files = [];
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) files.push(...await listFiles(resolve(current, entry.name), relativePath));
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(relativePath);
    }
    return files;
  }

  for (const root of ROOTS) visit(root);
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

execFileSync("codex", ["app-server", "generate-ts", "--experimental", "--out", protocolDirectory], { stdio: "inherit" });
await pruneAndFixBindings(protocolDirectory);
