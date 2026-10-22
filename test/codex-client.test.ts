/** @file The Codex JSON-RPC client against a fake app-server transport. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexClient, CodexRpcError, appServerArgs, parseServerVersion, refusalFor } from "../src/codex/client.ts";
import { RuntimeCompatibilityError, RuntimeConnectionError, RuntimeProtocolError } from "../src/errors.ts";
import { codexVersionIncompatibility } from "../src/codex/protocol/version.ts";
import { NO_REPLY, fakeSpawner, until } from "./fake-app-server.ts";

test("connect completes initialize, sends initialized and records the version", async () => {
  const { spawn, children } = fakeSpawner();
  const client = await CodexClient.connect({ cwd: "/tmp", spawnProcess: spawn, clientName: "tests" });
  const child = children[0];
  assert.equal(client.serverVersion.length > 0, true);
  assert.equal(child.received[0].method, "initialize");
  assert.equal(child.received[0].params.clientInfo.name, "tests");
  assert.equal(child.received[0].params.capabilities.experimentalApi, true);
  assert.equal(child.received[1].method, "initialized");
  assert.deepEqual(child.args.slice(0, 4), ["app-server", "--strict-config", "--listen", "stdio://"]);
  await client.close();
  assert.equal(child.exited, true);
});

test("connect refuses an older or different-major runtime and cleans up", async () => {
  const { spawn, children } = fakeSpawner({ initialize: () => ({ userAgent: "codex_cli_rs/0.1.0 (Mac)" }) });
  await assert.rejects(CodexClient.connect({ cwd: "/tmp", spawnProcess: spawn }), RuntimeCompatibilityError);
  assert.equal(children[0].exited, true);
  assert.equal(codexVersionIncompatibility("0.170.2", "0.163.0"), undefined);
  assert.match(codexVersionIncompatibility("1.0.0", "0.163.0") ?? "", /different major/);
  assert.match(codexVersionIncompatibility("0.163.0-alpha.1", "0.163.0") ?? "", /prerelease/);
});

test("connect needs an absolute cwd", async () => {
  await assert.rejects(CodexClient.connect({ cwd: "relative" }), /absolute cwd/);
});

test("requests correlate out of order and JSON-RPC errors reject with CodexRpcError", async () => {
  const { spawn, children } = fakeSpawner({
    slow: (_params, server) => {
      setTimeout(() => server.notify("ignored", {}), 0);
      return NO_REPLY;
    },
    echo: (params) => ({ echoed: params.value }),
    broken: () => new Error("nope"),
  });
  const client = await CodexClient.connect({ cwd: "/tmp", spawnProcess: spawn });
  const first = client.request("echo", { value: 1 });
  const second = client.request("echo", { value: 2 });
  assert.deepEqual(await Promise.all([second, first]), [{ echoed: 2 }, { echoed: 1 }]);
  await assert.rejects(client.request("broken", {}), (error: unknown) => error instanceof CodexRpcError && error.method === "broken" && /nope/.test(error.message));
  await client.close();
  assert.equal(children.length, 1);
});

test("a request that times out closes the connection", async () => {
  const { spawn, children } = fakeSpawner({ hang: () => NO_REPLY });
  const client = await CodexClient.connect({ cwd: "/tmp", spawnProcess: spawn, requestTimeoutMs: 30 });
  await assert.rejects(client.request("hang", {}), /timed out: hang/);
  assert.equal(client.isClosed, true);
  assert.equal(children[0].exited, true);
});

test("notifications reach listeners, and a throwing listener does not break others", async () => {
  const { spawn, children } = fakeSpawner();
  const client = await CodexClient.connect({ cwd: "/tmp", spawnProcess: spawn });
  const seen: string[] = [];
  client.onNotification(() => {
    throw new Error("bad listener");
  });
  client.onNotification((notification) => seen.push(notification.method));
  children[0].notify("turn/started", { threadId: "t" });
  children[0].raw(`${JSON.stringify({ method: "item/started", params: {} })}\n${JSON.stringify({ method: "turn/completed", params: {} })}`);
  children[0].raw("\n");
  await until(() => seen.length === 3);
  assert.deepEqual(seen, ["turn/started", "item/started", "turn/completed"]);
  await client.close();
});

test("server requests go to the handler; without one, approvals are declined", async () => {
  const { spawn, children } = fakeSpawner();
  const client = await CodexClient.connect({ cwd: "/tmp", spawnProcess: spawn });
  assert.deepEqual(await children[0].ask("item/commandExecution/requestApproval", { command: "ls" }), { decision: "decline" });
  assert.deepEqual(await children[0].ask("item/tool/requestUserInput", {}), { answers: {} });
  client.setServerRequestHandler(async ({ method, params }) => (method === "item/tool/call" ? { echoed: (params as any).tool } : undefined));
  assert.deepEqual(await children[0].ask("item/tool/call", { tool: "lookup" }), { echoed: "lookup" });
  const unknown = await children[0].ask("something/else", {});
  assert.equal(unknown.error.code, -32601);
  client.setServerRequestHandler(async () => {
    throw new Error("handler failed");
  });
  const failed = await children[0].ask("item/tool/call", {});
  assert.equal(failed.error.message, "handler failed");
  await client.close();
});

test("malformed JSON fails the connection with a protocol error", async () => {
  const { spawn, children } = fakeSpawner({ hang: () => NO_REPLY });
  const client = await CodexClient.connect({ cwd: "/tmp", spawnProcess: spawn });
  const pending = client.request("hang", {});
  children[0].raw("{not json}\n");
  await assert.rejects(pending, RuntimeProtocolError);
  assert.equal(client.isClosed, true);
});

test("an oversized line fails the connection", async () => {
  const { spawn, children } = fakeSpawner({ hang: () => NO_REPLY });
  const client = await CodexClient.connect({ cwd: "/tmp", spawnProcess: spawn, maxLineBytes: 200 });
  const pending = client.request("hang", {});
  children[0].raw("x".repeat(300));
  await assert.rejects(pending, /exceeded the configured limit/);
});

test("a child exit rejects pending requests and notifies close listeners once", async () => {
  const { spawn, children } = fakeSpawner({ hang: () => NO_REPLY });
  const client = await CodexClient.connect({ cwd: "/tmp", spawnProcess: spawn });
  const closes: Error[] = [];
  client.onClose((error) => closes.push(error));
  const pending = client.request("hang", {});
  children[0].exit();
  await assert.rejects(pending, RuntimeConnectionError);
  await client.close();
  assert.equal(closes.length, 1);
  await assert.rejects(client.request("anything", {}), /closed/);
});

test("appServerArgs encodes features and config safely", () => {
  assert.deepEqual(
    appServerArgs({ disabledFeatures: ["shell_tool"], enabledFeatures: ["multi_agent"], config: { approval_policy: "never", "mcp_servers.x.enabled": false, "mcp_servers.y.args": ["-y", "pkg"], tools: { web: true } } }),
    [
      "app-server", "--strict-config", "--listen", "stdio://",
      "--disable", "shell_tool", "--enable", "multi_agent",
      "--config", 'approval_policy="never"',
      "--config", "mcp_servers.x.enabled=false",
      "--config", 'mcp_servers.y.args=["-y","pkg"]',
      "--config", "tools={web=true}",
    ],
  );
  assert.throws(() => appServerArgs({ config: { "bad key=1": true } }), /cannot be passed safely/);
  assert.throws(() => appServerArgs({ disabledFeatures: ["a b"] }), /cannot be passed safely/);
  assert.throws(() => appServerArgs({ config: { x: "line\nbreak" } }), /control character/);
  assert.deepEqual(appServerArgs({ strictConfig: false }), ["app-server", "--listen", "stdio://"]);
});

test("parseServerVersion and refusalFor", () => {
  assert.equal(parseServerVersion("codex_cli_rs/0.163.0 (Mac OS 26.0.1; arm64) vscode/1.2"), "0.163.0");
  assert.equal(parseServerVersion("no version"), undefined);
  assert.deepEqual(refusalFor("item/fileChange/requestApproval"), { decision: "decline" });
  assert.equal(refusalFor("unknown/method"), undefined);
});
