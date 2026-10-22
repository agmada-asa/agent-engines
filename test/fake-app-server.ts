/**
 * @file An in-process stand-in for `codex app-server --listen stdio://`. It
 * speaks newline-delimited JSON-RPC over fake stdio, so tests drive the real
 * client and engine with no Codex process, sign-in or model call. Tests answer
 * requests by method and push notifications and server requests themselves.
 */

import { EventEmitter } from "node:events";
import type { CodexChildProcess, SpawnCodexProcess } from "../src/codex/client.ts";
import { CODEX_PROTOCOL_VERSION } from "../src/codex/protocol/version.ts";

type Handler = (params: any, server: FakeAppServer) => unknown;

/** Fake child: parses client JSONL from stdin and answers with the registered handlers. */
export class FakeAppServer extends EventEmitter implements CodexChildProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin: CodexChildProcess["stdin"];
  /** Every client message, in order. */
  readonly received: any[] = [];
  /** Answers the client sent to server requests, by request id. */
  readonly answers = new Map<number | string, any>();
  exited = false;
  private buffer = "";
  private nextServerId = 1000;
  private readonly waiting = new Map<number | string, (message: any) => void>();

  constructor(readonly args: readonly string[], private readonly handlers: Record<string, Handler>) {
    super();
    const stdin = new EventEmitter() as EventEmitter & CodexChildProcess["stdin"];
    stdin.write = (chunk: string) => {
      this.receive(chunk);
      return true;
    };
    stdin.end = () => undefined;
    this.stdin = stdin;
  }

  kill(): boolean {
    this.exit();
    return true;
  }

  /** Emits `close` once, as a crash or kill would. */
  exit(): void {
    if (this.exited) return;
    this.exited = true;
    queueMicrotask(() => this.emit("close", 0));
  }

  /** Sends one notification to the client. */
  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  /** Sends one server request and resolves with the client's answer. */
  ask(method: string, params: unknown): Promise<any> {
    const id = this.nextServerId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.write({ id, method, params });
    });
  }

  /** Writes raw text to stdout, for malformed-input tests. */
  raw(text: string): void {
    this.stdout.emit("data", Buffer.from(text));
  }

  /** Requests the client made for one method. */
  requests(method: string): any[] {
    return this.received.filter((message) => message.method === method && message.id !== undefined).map((message) => message.params);
  }

  private write(message: unknown): void {
    if (this.exited) return;
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.handle(JSON.parse(line));
      newline = this.buffer.indexOf("\n");
    }
  }

  private handle(message: any): void {
    this.received.push(message);
    if (message.method === undefined) {
      // An answer to one of our server requests.
      this.answers.set(message.id, message.result ?? { error: message.error });
      this.waiting.get(message.id)?.(message.result ?? { error: message.error });
      this.waiting.delete(message.id);
      return;
    }
    if (message.id === undefined) return;
    const handler = this.handlers[message.method] ?? DEFAULTS[message.method];
    queueMicrotask(() => {
      if (!handler) return this.write({ id: message.id, error: { code: -32601, message: `no handler for ${message.method}` } });
      try {
        const result = handler(message.params, this);
        if (result instanceof Error) this.write({ id: message.id, error: { code: -32000, message: result.message } });
        else if (result !== NO_REPLY) this.write({ id: message.id, result });
      } catch (error) {
        this.write({ id: message.id, error: { code: -32000, message: (error as Error).message } });
      }
    });
  }
}

/** Return from a handler to leave a request unanswered. */
export const NO_REPLY = Symbol("no reply");

const DEFAULTS: Record<string, Handler> = {
  initialize: () => ({ userAgent: `codex_cli_rs/${CODEX_PROTOCOL_VERSION} (Mac OS 26.0; arm64)` }),
  "account/read": () => ({ account: { type: "chatgpt", email: "someone@example.com", planType: "plus" }, requiresOpenaiAuth: true }),
  "thread/unsubscribe": () => ({}),
};

/** A spawn function plus every child it made. */
export function fakeSpawner(handlers: Record<string, Handler> = {}): { spawn: SpawnCodexProcess; children: FakeAppServer[] } {
  const children: FakeAppServer[] = [];
  return {
    children,
    spawn: (_command, args) => {
      const child = new FakeAppServer(args, handlers);
      children.push(child);
      return child;
    },
  };
}

/** Waits until `check` passes, polling the event loop. */
export async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
