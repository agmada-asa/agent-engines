/**
 * @file A bounded stdio JSON-RPC client for one `codex app-server --listen
 * stdio://` child. Adapted from an earlier app's `agent-runtime` client (itself from
 * Blitz's `codex-app-server.ts`), with the policy taken out: launch flags,
 * server-request answers and which methods are called are all the caller's.
 *
 * It correlates requests and responses, routes notifications and server
 * requests, checks the serving version on `initialize`, bounds every buffer, and
 * cleans the child up exactly once however the connection ends.
 */

import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  AgentEngineError,
  RuntimeCompatibilityError,
  RuntimeConnectionError,
  RuntimeProtocolError,
} from "../errors.ts";
import type { InitializeParams } from "./protocol/InitializeParams.ts";
import type { InitializeResponse } from "./protocol/InitializeResponse.ts";
import { CODEX_PROTOCOL_VERSION, codexVersionIncompatibility } from "./protocol/version.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_LINE_BYTES = 8_000_000;
const DEFAULT_MAX_PENDING_REQUESTS = 64;
const DEFAULT_MAX_REQUEST_BYTES = 8_000_000;
/** Upper bound on retained child stderr; only used to explain a failed startup. */
const STDERR_TAIL_BYTES = 2_048;
/** Grace period between SIGTERM and SIGKILL when the child is closed. */
const FORCE_KILL_AFTER_MS = 2_000;

/** Minimal readable side of a child process, injectable for transport tests. */
export interface CodexReadable {
  on(event: "data" | "end", listener: (...args: unknown[]) => void): unknown;
}

/** Minimal writable side of a child process, injectable for transport tests. */
export interface CodexWritable {
  write(chunk: string): boolean;
  end(): void;
  on(event: "error", listener: (...args: unknown[]) => void): unknown;
}

/** Minimal child-process surface required by the JSONL transport. */
export interface CodexChildProcess {
  stdin: CodexWritable;
  stdout: CodexReadable;
  stderr?: CodexReadable;
  on(event: "error" | "close", listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Spawns a child; tests inject fakes, production spawns the installed CLI without a shell. */
export type SpawnCodexProcess = (
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv }>,
) => CodexChildProcess;

/** One server notification. */
export interface CodexNotification {
  method: string;
  params: unknown;
}

/**
 * Answers one server request (approvals, questions, host tool calls). Return the
 * result to send; throw to send a JSON-RPC error. `undefined` means "not handled".
 */
export type CodexServerRequestHandler = (request: { id: number | string; method: string; params: unknown }) => Promise<unknown>;

/** A JSON-RPC error the server returned for one request. */
export class CodexRpcError extends AgentEngineError {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method}: ${message}`);
  }
}

/** Launch flags for the child; nothing is switched off unless asked. */
export interface CodexLaunchOptions {
  /** `--disable <feature>` for each. */
  disabledFeatures?: readonly string[];
  /** `--enable <feature>` for each. */
  enabledFeatures?: readonly string[];
  /** `--config key=value` overrides for the whole process, such as `approval_policy` or `mcp_servers.x.enabled`. */
  config?: Readonly<Record<string, unknown>>;
  /** Fail on unknown config keys (`--strict-config`). Defaults to true. */
  strictConfig?: boolean;
}

/** Connection options for one app-server child. */
export interface CodexClientOptions {
  /** Absolute working directory for the process; threads can set their own. */
  cwd: string;
  /** Codex executable; defaults to `codex` on PATH. */
  executable?: string;
  /** Child environment; defaults to the current environment. */
  env?: NodeJS.ProcessEnv;
  launch?: CodexLaunchOptions;
  /** Answers server requests; without one, approvals are declined and the rest refused. */
  onServerRequest?: CodexServerRequestHandler;
  /** Oldest accepted serving version; defaults to the version the bindings were generated from. */
  minimumVersion?: string;
  /** Client name sent on `initialize`. */
  clientName?: string;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
  maxPendingRequests?: number;
  maxRequestBytes?: number;
  spawnProcess?: SpawnCodexProcess;
}

/** Config keys that can be interpolated into one dotted `--config` key. */
const CONFIG_KEY = /^[A-Za-z0-9_-]{1,128}(\.[A-Za-z0-9_-]{1,128})*$/u;

/** Encodes a config value as TOML. JSON strings, numbers, booleans and arrays are valid TOML. */
function tomlValue(value: unknown, key: string): string {
  if (typeof value === "string") {
    if (/[\u0000-\u001f]/u.test(value)) throw new AgentEngineError(`Codex config ${key} has a control character.`);
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => tomlValue(item, key)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).map(([name, item]) => {
      if (!/^[A-Za-z0-9_-]+$/u.test(name)) throw new AgentEngineError(`Codex config ${key} has an unsafe key ${JSON.stringify(name)}.`);
      return `${name}=${tomlValue(item, key)}`;
    }).join(",")}}`;
  }
  throw new AgentEngineError(`Codex config ${key} has an unsupported value.`);
}

/** Builds `codex app-server` arguments from launch options. Keys are checked so no value opens another key. */
export function appServerArgs(options: CodexLaunchOptions = {}): string[] {
  const args = ["app-server", ...(options.strictConfig === false ? [] : ["--strict-config"]), "--listen", "stdio://"];
  for (const feature of new Set(options.disabledFeatures ?? [])) args.push("--disable", checkedName(feature, "feature"));
  for (const feature of new Set(options.enabledFeatures ?? [])) args.push("--enable", checkedName(feature, "feature"));
  for (const [key, value] of Object.entries(options.config ?? {})) {
    if (!CONFIG_KEY.test(key)) throw new AgentEngineError(`Codex config key ${JSON.stringify(key)} cannot be passed safely.`);
    args.push("--config", `${key}=${tomlValue(value, key)}`);
  }
  return args;
}

function checkedName(name: string, what: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(name)) throw new AgentEngineError(`Codex ${what} ${JSON.stringify(name)} cannot be passed safely.`);
  return name;
}

/** Spawns the installed Codex CLI directly (no shell) with piped stdio. */
function defaultSpawnProcess(command: string, args: readonly string[], options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv }>): CodexChildProcess {
  return spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as unknown as CodexChildProcess;
}

/** Reads the serving version from the app-server's user agent. */
export function parseServerVersion(userAgent: string): string | undefined {
  return userAgent.match(/\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|\(|$)/u)?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The safe answer when nobody handles a server request: decline approvals, answer nothing. */
export function refusalFor(method: string): unknown {
  if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
  if (method === "item/tool/requestUserInput") return { answers: {} };
  if (method === "mcpServer/elicitation/request") return { action: "cancel", content: null, _meta: null };
  if (method === "item/tool/call") {
    return { contentItems: [{ type: "inputText", text: "No host tools are available." }], success: false };
  }
  if (method.endsWith("requestApproval") || method === "applyPatchApproval" || method === "execCommandApproval") return { decision: "decline" };
  return undefined;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Bounded JSONL client for one app-server child. */
export class CodexClient {
  /** Serving version reported on `initialize`. */
  serverVersion = "";
  private readonly child: CodexChildProcess;
  private readonly requestTimeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly maxPendingRequests: number;
  private readonly maxRequestBytes: number;
  private serverRequestHandler?: CodexServerRequestHandler;
  private readonly decoder = new StringDecoder("utf8");
  private readonly notificationListeners = new Set<(notification: CodexNotification) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private inputBuffer = "";
  private stderrTail = "";
  private initialized = false;
  private closed = false;
  private processClosed = false;
  private terminationRequested = false;
  private forceKillTimer?: ReturnType<typeof setTimeout>;

  /**
   * Spawns the child, completes `initialize` and checks the serving version.
   * Throws `RuntimeCompatibilityError` for an older or different-major runtime and
   * `RuntimeConnectionError` (with the stderr tail) if the child fails to start.
   * The child is always cleaned up on failure.
   */
  static async connect(options: CodexClientOptions): Promise<CodexClient> {
    if (typeof options.cwd !== "string" || !isAbsolute(options.cwd)) {
      throw new AgentEngineError("Codex app-server needs an absolute cwd.");
    }
    for (const [name, value] of [["requestTimeoutMs", options.requestTimeoutMs], ["maxLineBytes", options.maxLineBytes],
      ["maxPendingRequests", options.maxPendingRequests], ["maxRequestBytes", options.maxRequestBytes]] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) throw new AgentEngineError(`Codex app-server ${name} must be a positive integer.`);
    }
    const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
    const child = spawnProcess(options.executable ?? "codex", appServerArgs(options.launch), {
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
    const client = new CodexClient(child, options);
    try {
      await client.initialize(options.minimumVersion ?? CODEX_PROTOCOL_VERSION, options.clientName ?? "agent-engines");
      return client;
    } catch (error) {
      const tail = client.stderrTail.trim();
      await client.close();
      if (error instanceof RuntimeCompatibilityError || error instanceof RuntimeProtocolError) throw error;
      const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT" || /ENOENT/u.test(String((error as Error)?.message));
      throw new RuntimeConnectionError(
        `Codex app-server failed to start: ${error instanceof Error ? error.message : "unknown error"}${tail ? ` (stderr: ${tail})` : ""}`,
        { cause: missing ? Object.assign(new Error("ENOENT"), { code: "ENOENT" }) : error },
      );
    }
  }

  private constructor(child: CodexChildProcess, options: CodexClientOptions) {
    this.child = child;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.maxPendingRequests = options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
    this.maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.serverRequestHandler = options.onServerRequest;
    child.stdout.on("data", (chunk: unknown) => this.handleStdoutChunk(chunk));
    child.stdout.on("end", () => this.handleStdoutEnd());
    child.stderr?.on("data", (chunk: unknown) => {
      // Keep only a short tail so a noisy child cannot grow memory.
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_TAIL_BYTES);
    });
    child.stdin.on("error", (error: unknown) => this.handleProcessError(error));
    child.on("error", (error: unknown) => this.handleProcessError(error));
    child.on("close", () => this.handleProcessClose());
  }

  /** Replaces the server-request handler. */
  setServerRequestHandler(handler: CodexServerRequestHandler | undefined): void {
    this.serverRequestHandler = handler;
  }

  /** Subscribes to server notifications; returns an unsubscribe function. */
  onNotification(listener: (notification: CodexNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /** Subscribes to the connection closing for any reason; fires at most once. */
  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Sends one request and resolves with its result. Any protocol method can be
   * called; the engine wraps the ones it uses. A JSON-RPC error rejects with `CodexRpcError`.
   */
  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new RuntimeConnectionError("Codex app-server connection is closed."));
    if (method !== "initialize" && !this.initialized) return Promise.reject(new RuntimeConnectionError("Codex app-server is not initialized."));
    if (this.pending.size >= this.maxPendingRequests) return Promise.reject(new AgentEngineError("Too many pending Codex app-server requests."));
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        const error = new AgentEngineError(`Codex app-server request timed out: ${method} (${this.requestTimeoutMs}ms).`);
        reject(error);
        // A runtime that stops answering is unusable; close it rather than leak requests.
        this.shutdown(error);
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve: resolve as (result: unknown) => void, reject, timer });
      try {
        this.writeMessage({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new RuntimeConnectionError("Codex request could not be written."));
      }
    });
  }

  /** Stops the child, rejects pending requests and notifies close listeners once. */
  async close(): Promise<void> {
    this.shutdown(new RuntimeConnectionError("Codex app-server connection closed."));
  }

  private async initialize(minimumVersion: string, clientName: string): Promise<void> {
    const params: InitializeParams = {
      clientInfo: { name: clientName, title: clientName, version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    };
    const response = await this.request<InitializeResponse>("initialize", params);
    if (!isRecord(response) || typeof response.userAgent !== "string") {
      throw new RuntimeProtocolError("Codex app-server returned a malformed initialize response.");
    }
    const serverVersion = parseServerVersion(response.userAgent);
    const incompatibility = serverVersion === undefined
      ? `its user agent "${response.userAgent}" has no recognizable version`
      : codexVersionIncompatibility(serverVersion, minimumVersion);
    if (incompatibility) throw new RuntimeCompatibilityError(`Codex app-server is incompatible: ${incompatibility}.`);
    this.serverVersion = serverVersion ?? "";
    this.writeMessage({ method: "initialized" });
    this.initialized = true;
  }

  private handleStdoutChunk(chunk: unknown): void {
    if (this.closed) return;
    this.inputBuffer += this.decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
    let newlineIndex = this.inputBuffer.indexOf("\n");
    while (newlineIndex >= 0 && !this.closed) {
      const line = this.inputBuffer.slice(0, newlineIndex).replace(/\r$/u, "");
      this.inputBuffer = this.inputBuffer.slice(newlineIndex + 1);
      if (Buffer.byteLength(line) > this.maxLineBytes) return this.failProtocol("Codex app-server JSONL line exceeded the configured limit.");
      if (line.trim()) this.handleLine(line);
      newlineIndex = this.inputBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.inputBuffer) > this.maxLineBytes) this.failProtocol("Codex app-server JSONL line exceeded the configured limit.");
  }

  /** Rejects an unterminated final line instead of silently dropping it. */
  private handleStdoutEnd(): void {
    if (this.closed) return;
    this.inputBuffer += this.decoder.end();
    if (this.inputBuffer.trim()) this.failProtocol("Codex app-server ended with an incomplete JSONL message.");
  }

  /** Dispatches one message: response, notification or server request. */
  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return this.failProtocol("Codex app-server emitted malformed JSON.");
    }
    if (!isRecord(message)) return this.failProtocol("Codex JSON-RPC message must be an object.");
    const { id, method } = message;
    if (typeof method === "string") {
      if (id === undefined || id === null) {
        this.emitNotification({ method, params: message.params });
        return;
      }
      if (typeof id !== "number" && typeof id !== "string") return this.failProtocol("Codex server request has an invalid id.");
      void this.handleServerRequest(id, method, message.params);
      return;
    }
    if (typeof id !== "number") return this.failProtocol("Codex JSON-RPC response has an invalid id.");
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (isRecord(message.error)) {
      const text = typeof message.error.message === "string" ? message.error.message : "request failed";
      const code = typeof message.error.code === "number" ? message.error.code : undefined;
      pending.reject(new CodexRpcError(pending.method, code, text, message.error.data));
      return;
    }
    pending.resolve(message.result);
  }

  /** Answers one server request through the handler, falling back to a refusal. */
  private async handleServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    let result: unknown;
    let failure: string | undefined;
    try {
      result = this.serverRequestHandler ? await this.serverRequestHandler({ id, method, params }) : undefined;
      if (result === undefined) result = refusalFor(method);
    } catch (error) {
      failure = error instanceof Error ? error.message : "The request could not be handled.";
    }
    if (this.closed) return;
    try {
      if (failure !== undefined) this.writeMessage({ id, error: { code: -32603, message: failure } });
      else if (result === undefined) this.writeMessage({ id, error: { code: -32601, message: `Unhandled server request ${method}.` } });
      else this.writeMessage({ id, result });
    } catch (error) {
      this.shutdown(error instanceof Error ? error : new RuntimeConnectionError("Codex server request response could not be written."));
    }
  }

  private writeMessage(message: Record<string, unknown>): void {
    const serialized = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(serialized) > this.maxRequestBytes) throw new AgentEngineError("Codex app-server message exceeded the configured size limit.");
    try {
      this.child.stdin.write(serialized);
    } catch {
      throw new RuntimeConnectionError("Codex app-server stdin is unavailable.");
    }
  }

  private emitNotification(notification: CodexNotification): void {
    for (const listener of this.notificationListeners) {
      try {
        listener(notification);
      } catch {
        // A consumer must not break protocol correlation.
      }
    }
  }

  private failProtocol(message: string): void {
    this.shutdown(new RuntimeProtocolError(message));
  }

  private handleProcessError(error: unknown): void {
    const failure = new RuntimeConnectionError(`Codex app-server process failed: ${error instanceof Error ? error.message : "unknown error"}`, { cause: error });
    this.shutdown(failure);
  }

  private handleProcessClose(): void {
    this.processClosed = true;
    if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
    this.shutdown(new RuntimeConnectionError("Codex app-server process exited."));
  }

  /** Closes exactly once: rejects pending requests, terminates the child and notifies close listeners. */
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
      // The process may already have exited.
    }
    this.terminateProcess();
    for (const listener of this.closeListeners) {
      try {
        listener(error);
      } catch {
        // Listener failures cannot block cleanup.
      }
    }
    this.closeListeners.clear();
    this.notificationListeners.clear();
  }

  /** Requests graceful termination and escalates to SIGKILL after a short grace period. */
  private terminateProcess(): void {
    if (this.terminationRequested || this.processClosed) return;
    this.terminationRequested = true;
    try {
      this.child.kill("SIGTERM");
    } catch {
      // Cleanup is best effort and idempotent.
    }
    this.forceKillTimer = setTimeout(() => {
      if (this.processClosed) return;
      try {
        this.child.kill("SIGKILL");
      } catch {
        // The child may have exited between the two signals.
      }
    }, FORCE_KILL_AFTER_MS);
    this.forceKillTimer.unref?.();
  }
}
