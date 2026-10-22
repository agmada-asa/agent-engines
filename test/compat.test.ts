/** @file Runtime compatibility: the Codex contract stays complete, and drift is reported. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  CODEX_PROTOCOL_CONTRACT,
  checkMinimumVersion,
  codexProtocolProblems,
  diffModelCatalog,
  hasModelCatalogDrift,
  type CodexProtocolSurface,
} from "../src/compat.ts";

const source = (path: string) => readFile(new URL(`../src/codex/${path}`, import.meta.url), "utf8");

test("every Codex method the engine calls is in the contract", async () => {
  const code = (await source("engine.ts")) + (await source("client.ts"));
  const called = new Set([...code.matchAll(/request(?:<[^>]*>)?\(\s*"([^"]+)"/gu)].map((match) => match[1]));
  assert.ok(called.size >= 8, "the scan should find the engine's requests");
  for (const method of called) assert.ok((CODEX_PROTOCOL_CONTRACT.clientRequests as readonly string[]).includes(method), `${method} is missing from the contract`);
});

test("every notification and server request the normaliser handles is in the contract", async () => {
  const code = await source("normalize.ts");
  const handled = [...code.matchAll(/(?:case|method ===) "([a-z][A-Za-z]*(?:\/[A-Za-z]+)+|error)"/gu)].map((match) => match[1]);
  const known = new Set<string>([...CODEX_PROTOCOL_CONTRACT.serverNotifications, ...CODEX_PROTOCOL_CONTRACT.serverRequests]);
  assert.ok(handled.length >= 10);
  for (const method of handled) assert.ok(known.has(method), `${method} is missing from the contract`);
});

/** A schema surface with everything the contract needs, minus `drop`. */
function surface(drop: string[] = []): CodexProtocolSurface {
  const keep = (values: readonly string[]) => new Set(values.filter((value) => !drop.includes(value)));
  const definitions: Record<string, unknown> = {};
  for (const [name, values] of Object.entries(CODEX_PROTOCOL_CONTRACT.enums)) {
    if (drop.includes(name)) continue;
    definitions[name] = { oneOf: values.filter((value) => !drop.includes(value)).map((value) => ({ properties: { type: { enum: [value] } } })) };
  }
  return {
    methods: {
      clientRequests: keep(CODEX_PROTOCOL_CONTRACT.clientRequests),
      clientNotifications: keep(CODEX_PROTOCOL_CONTRACT.clientNotifications),
      serverNotifications: keep(CODEX_PROTOCOL_CONTRACT.serverNotifications),
      serverRequests: keep(CODEX_PROTOCOL_CONTRACT.serverRequests),
    },
    definitions,
  };
}

test("codexProtocolProblems reports missing methods, enum values and definitions", () => {
  assert.deepEqual(codexProtocolProblems(surface()), []);
  assert.deepEqual(codexProtocolProblems(surface(["turn/steer", "usageLimitExceeded", "SubAgentActivityKind"])), [
    "Missing client request: turn/steer",
    "CodexErrorInfo no longer includes usageLimitExceeded",
    "Missing protocol definition: SubAgentActivityKind",
  ]);
});

test("checkMinimumVersion", () => {
  assert.equal(checkMinimumVersion("2.1.308 (Claude Code)", "2.1.248"), undefined);
  assert.match(checkMinimumVersion("2.1.100", "2.1.248") ?? "", /2.1.248 or newer/);
  assert.match(checkMinimumVersion("garbage", "2.1.248") ?? "", /not a recognisable version/);
});

test("diffModelCatalog", () => {
  const drift = diffModelCatalog(
    [{ id: "a", efforts: ["low"] }, { id: "gone" }],
    [{ id: "a", efforts: ["low", "high"] }, { id: "new" }],
  );
  assert.deepEqual(drift, { added: ["new"], removed: ["gone"], changed: [{ id: "a", expected: ["low"], live: ["low", "high"] }] });
  assert.equal(hasModelCatalogDrift(drift), true);
  assert.equal(hasModelCatalogDrift(diffModelCatalog([{ id: "a" }], [{ id: "a" }])), false);
});
