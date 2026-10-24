/**
 * @file A stdio JSON-RPC client for one Agent Client Protocol (ACP) agent:
 * OpenCode (`opencode acp`), Gemini CLI (`gemini --acp`) and the rest. It
 * correlates requests and responses, routes notifications and the agent's own
 * requests, bounds what it buffers and cleans the child up once.
 *
 * Protocol: newline-delimited JSON-RPC 2.0, ACP protocol version 1.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { AgentEngineError, RuntimeConnectionError, RuntimeProtocolError } from "../errors.ts";

/** The ACP protocol version this client speaks. */
export const ACP_PROTOCOL_VERSION = 1;

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_LINE_BYTES = 16_000_000;
const STDERR_TAIL_BYTES = 4_096;
/** Grace period between SIGTERM and SIGKILL when the child is closed. */
const KILL_GRACE_MS = 2_000;

/** A JSON-RPC error answer from the agent. */
export class AcpRpcError extends AgentEngineError {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method} failed (${code}): ${message}`);
  }
}

/** The child process surface the client uses; tests pass a fake. */
export interface AcpChildProcess {
  readonly stdin: { write(chunk: string): boolean; end(): void; on(event: "error", listener: (error: Error) => void): unknown };
  readonly stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  readonly stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  on(event: "close", listener: (code: number | null, signal?: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Starts the agent process; tests inject a fake. */
export type SpawnAcpProcess = (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => AcpChildProcess;

/** Answers one request the agent sends (permission, elicitation). Throw to answer with an error. */
export type AcpRequestHandler = (method: string, params: unknown) => Promise<unknown>;

/** Settings for `AcpClient.connect`. */
export interface AcpClientOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  spawnProcess?: SpawnAcpProcess;
  onRequest: AcpRequestHandler;
}

interface Pending {
  method: string;
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

/** One connection to an ACP agent child. */
export class AcpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private stderrTail = "";
  private closed = false;

  private constructor(
    private readonly child: AcpChildProcess,
    private readonly options: AcpClientOptions,
  ) {}

  /** Starts the agent; `initialize` is the caller's first request. */
  static connect(options: AcpClientOptions): AcpClient {
    const spawnProcess: SpawnAcpProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
      spawn(command, [...args], { cwd: spawnOptions.cwd, env: spawnOptions.env, stdio: ["pipe", "pipe", "pipe"] }) as unknown as AcpChildProcess);
    const child = spawnProcess(options.command, options.args ?? [], { cwd: options.cwd, env: options.env });
    const client = new AcpClient(child, options);
    child.stdout.on("data", (chunk) => client.receive(chunk));
    child.stderr.on("data", (chunk) => {
      client.stderrTail = (client.stderrTail + String(chunk)).slice(-STDERR_TAIL_BYTES);
    });
    child.stdin.on("error", (error) => client.shutdown(new RuntimeConnectionError(`Could not write to the ACP agent: ${error.message}`, { cause: error })));
    child.on("error", (error) => client.shutdown(new RuntimeConnectionError(`The ACP agent did not start: ${error.message}`, { cause: error })));
    child.on("close", (code, signal) => {
      const detail = client.stderrTail.trim() ? `: ${client.stderrTail.trim().split("\n").slice(-3).join(" ")}` : "";
      client.shutdown(new RuntimeConnectionError(`The ACP agent exited (${signal ?? code ?? "unknown"})${detail}`));
    });
    return client;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** The end of the agent's stderr, for explaining a failure. */
  get stderr(): string {
    return this.stderrTail;
  }

  /** Sends a request and resolves with its result. `timeoutMs: 0` waits as long as it takes (a prompt turn). */
  request<T = unknown>(method: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) return Promise.reject(new RuntimeConnectionError("The ACP agent connection is closed."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const pending: Pending = { method, resolve: resolve as (result: unknown) => void, reject };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new AgentEngineError(`The ACP agent did not answer ${method} in ${timeoutMs}ms.`));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      try {
        this.write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(error instanceof Error ? error : new RuntimeConnectionError("The ACP request could not be written."));
      }
    });
  }

  /** Sends a notification (no answer). */
  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Ends the connection and stops the agent. */
  async close(): Promise<void> {
    this.shutdown(new RuntimeConnectionError("The ACP agent connection closed."));
  }

  private write(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: Buffer | string): void {
    if (this.closed) return;
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0 && !this.closed) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MAX_LINE_BYTES) this.shutdown(new RuntimeProtocolError("An ACP message was larger than the limit."));
  }

  private handleLine(line: string): void {
    let message: Record<string, any>;
    try {
      message = JSON.parse(line);
    } catch {
      // Agents should keep logs off stdout; a stray line is skipped rather than fatal.
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method === "string") {
      if (hasId) void this.answer(message.id, message.method, message.params);
      else for (const listener of this.notificationListeners) listener(message.method, message.params);
      return;
    }
    if (!hasId) return;
    const pending = this.pending.get(Number(message.id));
    if (!pending) return;
    this.pending.delete(Number(message.id));
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new AcpRpcError(pending.method, Number(message.error.code ?? -32603), String(message.error.message ?? "unknown error"), message.error.data));
    } else {
      pending.resolve(message.result);
    }
  }

  private async answer(id: unknown, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.options.onRequest(method, params);
      if (!this.closed) this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      const code = error instanceof AcpRpcError ? error.code : -32603;
      if (!this.closed) this.write({ jsonrpc: "2.0", id, error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private shutdown(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    try {
      this.child.stdin.end();
    } catch {
      // Already gone.
    }
    this.child.kill("SIGTERM");
    const force = setTimeout(() => this.child.kill("SIGKILL"), KILL_GRACE_MS);
    force.unref?.();
    for (const listener of this.closeListeners) listener(error);
  }
}
