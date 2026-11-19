/** @file The package's two entry points, the shared turn-error sorting and the pruned Codex bindings. */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AcpRpcError } from "../src/acp/client.ts";
import {
  AgentEngineError,
  RuntimeAuthError,
  RuntimeConnectionError,
  RuntimeModelSubstitutionError,
  RuntimeModelUnavailableError,
  turnError,
} from "../src/errors.ts";
import * as main from "../src/index.ts";
import * as internals from "../src/internals.ts";

const source = fileURLToPath(new URL("../src/", import.meta.url));
const protocol = join(source, "codex/protocol");

/** TypeScript files under `folder`, as `/`-separated paths relative to it. */
async function files(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(sep).join("/"));
}

test("turnError sorts runtime errors into the same kinds for every engine", () => {
  assert.deepEqual(turnError(new RuntimeAuthError("Sign in.")), { kind: "auth", message: "Sign in." });
  assert.equal(turnError(new RuntimeConnectionError("Gone.")).kind, "connection");
  assert.equal(turnError(new RuntimeModelUnavailableError("No such model.")).kind, "model");
  assert.equal(turnError(new RuntimeModelSubstitutionError("a", "b", "Claude")).kind, "model");
  assert.equal(turnError(new AcpRpcError("session/prompt", -32000, "Authentication required")).kind, "other", "ACP's auth code is the ACP engine's to read");
  assert.equal(turnError(new AgentEngineError("x")).kind, "other");
  assert.deepEqual(turnError("plain"), { kind: "other", message: "plain" });
});

test("the main entry point and agent-engines/internals export different things", () => {
  const shared = Object.keys(internals).filter((name) => name in main);
  assert.deepEqual(shared, []);
  assert.ok(Object.keys(internals).length > 0);
});

test("every checked-in Codex binding is reachable from the source's imports", async () => {
  const used = new Set(["version.ts"]);
  const visit = async (path: string): Promise<void> => {
    if (used.has(path)) return;
    used.add(path);
    const file = resolve(protocol, path);
    for (const [, imported] of (await readFile(file, "utf8")).matchAll(/from\s+"((?:\.\.\/|\.\/).+?)(?:\.ts)?"/gu)) {
      await visit(relative(protocol, resolve(dirname(file), `${imported}.ts`)).split(sep).join("/"));
    }
  };
  for (const file of await files(source)) {
    if (file.startsWith("codex/protocol/")) continue;
    for (const [, imported] of (await readFile(join(source, file), "utf8")).matchAll(/from\s+"[^"]*\/protocol\/([^"]+\.ts)"/gu)) await visit(imported);
  }
  const unused = (await files(protocol)).filter((file) => !used.has(file));
  assert.deepEqual(unused, [], "run npm run generate:protocol, or delete the files no import reaches");
});
