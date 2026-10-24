/**
 * @file An in-process stand-in for an ACP agent child (`opencode acp`,
 * `gemini --acp`). It speaks newline-delimited JSON-RPC over fake stdio, so
 * tests drive the real client and engine with no agent process, sign-in or
 * model call. Tests answer client requests by method, push `session/update`
 * notifications, and send the agent's own requests (permission, elicitation)
 * and await the client's answer.
 */

import { EventEmitter } from "node:events";
import type { AcpChildProcess, SpawnAcpProcess } from "../src/acp/client.ts";

/**
 * Answers one client request. Return a value to answer it, `NO_REPLY` to leave
 * it unanswered (the test answers later or never), or throw `FakeRpcError` to
 * answer with a chosen error code. A returned promise is awaited.
 */
export type AcpHandler = (params: any, agent: FakeAcpAgent) => unknown;

/** Return from a handler to leave a request unanswered. */
export const NO_REPLY = Symbol("no reply");

/** A JSON-RPC error answer with a chosen code. */
export class FakeRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type ConfigOption = Record<string, any>;

/** One session the fake agent holds. */
export interface FakeSession {
  modes: { currentModeId: string; availableModes: Array<{ id: string; name: string }> };
  configOptions: ConfigOption[];
}

/** A session with a build mode, a plan mode, a model choice and an effort choice. */
function freshSession(): FakeSession {
  return {
    modes: {
      currentModeId: "build",
      availableModes: [
        { id: "build", name: "Build" },
        { id: "plan", name: "Plan" },
      ],
    },
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "model-a",
        options: [
          { value: "model-a", name: "Model A", description: "Fast" },
          { value: "model-b", name: "Model B" },
        ],
      },
      {
        id: "thought_level",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: "low",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
    ],
  };
}

const DEFAULT_HANDLERS: Record<string, AcpHandler> = {
  initialize: () => ({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true },
      sessionCapabilities: { list: {}, fork: {}, close: {}, resume: {} },
    },
    agentInfo: { name: "fake-agent", version: "1.2.3" },
  }),
  "session/new": (_params, agent) => agent.openSession(),
  "session/set_config_option": (params, agent) => {
    const session = agent.session(params.sessionId);
    const option = session.configOptions.find((entry) => entry.id === params.configId);
    if (!option) throw new FakeRpcError(-32602, `no config option ${params.configId}`);
    option.currentValue = params.value;
    return { configOptions: session.configOptions };
  },
  "session/set_mode": (params, agent) => {
    agent.session(params.sessionId).modes.currentModeId = params.modeId;
    return {};
  },
  "session/prompt": () => ({ stopReason: "end_turn" }),
  "session/close": () => ({}),
};

/** Fake child: parses client JSONL from stdin and answers with the registered handlers. */
export class FakeAcpAgent extends EventEmitter implements AcpChildProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin: AcpChildProcess["stdin"];
  /** Every client message, in order: requests, notifications and answers to the agent's requests. */
  readonly received: any[] = [];
  /** Sessions by ID: opened by `session/new`, or first seen by any other call. */
  readonly sessions = new Map<string, FakeSession>();
  exited = false;
  private buffer = "";
  private nextId = 1000;
  private sessionCount = 0;
  private readonly handlers: Record<string, AcpHandler>;
  private readonly waiting = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();

  constructor(handlers: Record<string, AcpHandler> = {}) {
    super();
    this.handlers = { ...DEFAULT_HANDLERS, ...handlers };
    const stdin = new EventEmitter() as EventEmitter & AcpChildProcess["stdin"];
    stdin.write = (chunk: string) => {
      this.receive(chunk);
      return true;
    };
    stdin.end = () => undefined;
    this.stdin = stdin;
  }

  /** Replaces or adds the handler for one client method. */
  handle(method: string, handler: AcpHandler): void {
    this.handlers[method] = handler;
  }

  kill(): boolean {
    this.exit();
    return true;
  }

  /** Emits `close` once, as a crash or kill would. */
  exit(code: number | null = 1): void {
    if (this.exited) return;
    this.exited = true;
    queueMicrotask(() => this.emit("close", code, null));
  }

  /** Sends one notification to the client. */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Sends one `session/update` for a session. */
  update(sessionId: string, update: Record<string, unknown>): void {
    this.notify("session/update", { sessionId, update });
  }

  /** Sends a request to the client and resolves with its answer; rejects when the client answers with an error. */
  ask<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** The params of the client's requests with this method, in order. */
  requests(method: string): any[] {
    return this.received.filter((message) => message.method === method && message.id !== undefined).map((message) => message.params);
  }

  /** The params of the client's notifications with this method, in order. */
  notifications(method: string): any[] {
    return this.received.filter((message) => message.method === method && message.id === undefined).map((message) => message.params);
  }

  /** A session's state, created on first sight. */
  session(sessionId: string): FakeSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = freshSession();
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /** Opens a session and returns what `session/new` answers. */
  openSession(): { sessionId: string; modes: FakeSession["modes"]; configOptions: ConfigOption[] } {
    const sessionId = `sess-${++this.sessionCount}`;
    const session = this.session(sessionId);
    return { sessionId, modes: session.modes, configOptions: session.configOptions };
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
      if (line.trim()) this.dispatchLine(JSON.parse(line));
      newline = this.buffer.indexOf("\n");
    }
  }

  private dispatchLine(message: any): void {
    this.received.push(message);
    if (message.method === undefined) {
      // An answer to one of the agent's own requests.
      const pending = this.waiting.get(message.id);
      this.waiting.delete(message.id);
      if (message.error) pending?.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else pending?.resolve(message.result);
      return;
    }
    // A client notification is recorded only; nothing answers it.
    if (message.id === undefined) return;
    queueMicrotask(() => void this.answer(message.id, message.method, message.params));
  }

  private async answer(id: number, method: string, params: unknown): Promise<void> {
    try {
      const handler = this.handlers[method];
      if (!handler) throw new FakeRpcError(-32601, `no handler for ${method}`);
      const result = await handler(params, this);
      if (result === NO_REPLY) return;
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      const code = error instanceof FakeRpcError ? error.code : -32603;
      this.write({ jsonrpc: "2.0", id, error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  }
}

/** A spawn function plus every child it made, as `fakeSpawner` does for Codex. */
export function fakeAcpSpawner(handlers: Record<string, AcpHandler> = {}): { spawn: SpawnAcpProcess; children: FakeAcpAgent[] } {
  const children: FakeAcpAgent[] = [];
  return {
    children,
    spawn: () => {
      const child = new FakeAcpAgent(handlers);
      children.push(child);
      return child;
    },
  };
}
