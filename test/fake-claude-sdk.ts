/**
 * @file A scripted stand-in for the Claude Agent SDK's `query`. It reads the
 * engine's streaming input, lets each test answer user messages with SDK
 * messages, and records every option and control call. No Claude Code process.
 */

import type { ClaudeSdk } from "../src/claude/engine.ts";

type Message = Record<string, any>;

/** One fake Claude Code process. */
export class FakeQuery {
  readonly options: Record<string, any>;
  readonly inputs: Message[] = [];
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  closed = false;
  private readonly outbox: Message[] = [];
  private waiting?: () => void;
  private ended = false;
  private failure?: Error;

  constructor(
    private readonly prompt: AsyncIterable<Message>,
    options: Record<string, any>,
    private readonly script: FakeClaudeScript,
  ) {
    this.options = options;
    void this.readInput();
  }

  /** Sends one SDK message to the engine. */
  emit(message: Message): void {
    this.outbox.push({ session_id: this.options.sessionId ?? this.options.resume, uuid: `u${Math.random()}`, ...message });
    this.wake();
  }

  /** Ends the stream, as a process exit would. */
  end(): void {
    this.ended = true;
    this.wake();
  }

  /** Makes the stream throw, as the SDK does when Claude Code exits with an error. */
  fail(error: Error): void {
    this.failure = error;
    this.wake();
  }

  async initializationResult() {
    this.calls.push({ method: "initializationResult", args: [] });
    if (this.script.initError) throw this.script.initError;
    return {
      models: this.script.models ?? [{ value: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "Fast", supportedEffortLevels: ["low", "medium", "high"], supportsFastMode: false }],
      account: this.script.account ?? { subscriptionType: "max", email: "someone@example.com", apiKeySource: "none", apiProvider: "firstParty" },
      claude_code_version: this.script.version ?? "2.1.308",
      commands: this.script.commands ?? [], agents: [], output_style: "default", available_output_styles: [],
    };
  }

  async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options: unknown) {
    this.calls.push({ method: "usage", args: [options] });
    return this.script.usage ?? { subscription_type: "max", rate_limits_available: false, rate_limits: null };
  }

  async interrupt() {
    this.calls.push({ method: "interrupt", args: [] });
    this.script.onInterrupt?.(this);
  }

  async setModel(model?: string) {
    this.calls.push({ method: "setModel", args: [model] });
  }

  async applyFlagSettings(settings: unknown) {
    this.calls.push({ method: "applyFlagSettings", args: [settings] });
  }

  async setPermissionMode(mode: string) {
    this.calls.push({ method: "setPermissionMode", args: [mode] });
  }

  async getContextUsage() {
    this.calls.push({ method: "getContextUsage", args: [] });
    return {
      categories: [{ id: "messages", name: "Messages", tokens: 1200, color: "x", kind: "used" }, { id: "free_space", name: "Free space", tokens: 198_800, color: "y", kind: "free" }],
      totalTokens: 1200, maxTokens: 200_000, rawMaxTokens: 200_000, percentage: 0.6, gridRows: [], model: "claude-haiku-5-5", memoryFiles: [],
    };
  }

  async rewindFiles(userMessageId: string, options?: unknown) {
    this.calls.push({ method: "rewindFiles", args: [userMessageId, options] });
    return this.script.rewind ?? { canRewind: true, filesChanged: ["/tmp/a.ts"], insertions: 2, deletions: 1 };
  }

  async stopTask(taskId: string) {
    this.calls.push({ method: "stopTask", args: [taskId] });
  }

  async setMcpServers(servers: unknown) {
    this.calls.push({ method: "setMcpServers", args: [servers] });
    return { added: Object.keys(servers as object), removed: [], errors: {} };
  }

  async reconnectMcpServer(name: string) {
    this.calls.push({ method: "reconnectMcpServer", args: [name] });
  }

  async toggleMcpServer(name: string, enabled: boolean) {
    this.calls.push({ method: "toggleMcpServer", args: [name, enabled] });
  }

  async readMcpResource(server: string, uri: string) {
    this.calls.push({ method: "readMcpResource", args: [server, uri] });
    return { contents: [{ uri, mimeType: "text/plain", text: "resource text" }] };
  }

  async mcpServerStatus() {
    this.calls.push({ method: "mcpServerStatus", args: [] });
    return [];
  }

  async reloadSkills() {
    this.calls.push({ method: "reloadSkills", args: [] });
    return { skills: [] };
  }

  async supportedCommands() {
    this.calls.push({ method: "supportedCommands", args: [] });
    return [{ name: "deploy", description: "Ship it", argumentHint: "" }];
  }

  async reloadPlugins() {
    this.calls.push({ method: "reloadPlugins", args: [] });
    return { commands: [], agents: [], plugins: [{ name: "linear", path: "/p/linear", source: "official", version: "1.0" }], mcpServers: [], error_count: 0 };
  }

  close(): void {
    this.closed = true;
    this.end();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Message, void> {
    for (;;) {
      const message = this.outbox.shift();
      if (message) {
        yield message;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.waiting = resolve));
    }
  }

  private async readInput(): Promise<void> {
    for await (const message of this.prompt) {
      this.inputs.push(message);
      await this.script.onUser?.(message, this);
    }
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.();
  }
}

/** How the fake behaves. */
export interface FakeClaudeScript {
  models?: Message[];
  account?: Message;
  version?: string;
  initError?: Error;
  commands?: Message[];
  usage?: Message;
  /** Runs for each user message the engine sends. */
  onUser?: (message: Message, query: FakeQuery) => void | Promise<void>;
  onInterrupt?: (query: FakeQuery) => void;
  /** What `getSessionMessages` returns; defaults to a short session with a subagent message. */
  sessionMessages?: Message[];
  /** What `rewindFiles` returns. */
  rewind?: Message;
}

/** A fake SDK and every query it started. */
export function fakeClaudeSdk(script: FakeClaudeScript = {}): {
  sdk: ClaudeSdk;
  queries: FakeQuery[];
  deleted: Array<{ id: string; dir?: string }>;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const queries: FakeQuery[] = [];
  const deleted: Array<{ id: string; dir?: string }> = [];
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const sdk = {
    query: ({ prompt, options }: { prompt: AsyncIterable<Message>; options: Record<string, any> }) => {
      const query = new FakeQuery(prompt, options, script);
      queries.push(query);
      return query;
    },
    deleteSession: async (id: string, options?: { dir?: string }) => {
      deleted.push({ id, ...(options?.dir ? { dir: options.dir } : {}) });
    },
    // Every session exists except "never-prompted".
    getSessionInfo: async (id: string) => (id === "never-prompted" ? undefined : { sessionId: id, summary: "", lastModified: 0 }),
    forkSession: async (id: string, options: unknown) => {
      calls.push({ method: "forkSession", args: [id, options] });
      return { sessionId: `fork-of-${id}` };
    },
    listSessions: async (options: unknown) => {
      calls.push({ method: "listSessions", args: [options] });
      return [
        { sessionId: "s-old", summary: "Old work", lastModified: 1_790_000_000_000, firstPrompt: "Fix the build", cwd: "/tmp" },
        { sessionId: "s-new", summary: "Auto summary", customTitle: "Tests", lastModified: 1_790_000_900_000, firstPrompt: "Add tests", gitBranch: "main", cwd: "/tmp", createdAt: 1_789_000_000_000 },
      ];
    },
    renameSession: async (id: string, title: string, options: unknown) => {
      calls.push({ method: "renameSession", args: [id, title, options] });
    },
    resolveSettings: async (options: unknown) => {
      calls.push({ method: "resolveSettings", args: [options] });
      return { effective: { model: "opus" }, provenance: {}, sources: [{ source: "userSettings", settings: { model: "opus" }, path: "/home/.claude/settings.json" }] };
    },
    getSessionMessages: async (...args: unknown[]) => script.sessionMessages ?? (calls.push({ method: "getSessionMessages", args }), [
      { type: "user", uuid: "1", session_id: "s", parent_tool_use_id: null, parent_agent_id: null, message: { role: "user", content: "Hi" } },
      { type: "assistant", uuid: "2", session_id: "s", parent_tool_use_id: "task-1", parent_agent_id: null, message: { role: "assistant", content: [{ type: "text", text: "From a subagent" }] } },
      { type: "assistant", uuid: "3", session_id: "s", parent_tool_use_id: null, parent_agent_id: null, message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } },
    ]),
    getSubagentMessages: async () => [
      { type: "user", uuid: "1", session_id: "s", parent_tool_use_id: null, parent_agent_id: null, message: { role: "user", content: "Find the file" } },
      { type: "assistant", uuid: "2", session_id: "s", parent_tool_use_id: null, parent_agent_id: null, message: { role: "assistant", content: [{ type: "tool_use", id: "tu", name: "Glob", input: { pattern: "*.md" } }] } },
      { type: "user", uuid: "3", session_id: "s", parent_tool_use_id: null, parent_agent_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu", content: "README.md" }] } },
      { type: "assistant", uuid: "4", session_id: "s", parent_tool_use_id: null, parent_agent_id: null, message: { role: "assistant", content: [{ type: "text", text: "README.md" }] } },
    ],
  } as unknown as ClaudeSdk;
  return { sdk, queries, deleted, calls };
}

/** The SDK messages for a simple successful turn replying `text`. */
export function replyMessages(text: string, messageId = "msg_1"): Message[] {
  return [
    { type: "system", subtype: "init", model: "claude-haiku-5-5", claude_code_version: "2.1.308" },
    { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: messageId } } },
    { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
    { type: "assistant", parent_tool_use_id: null, message: { id: messageId, role: "assistant", content: [{ type: "text", text }] } },
    {
      type: "result", subtype: "success", is_error: false, result: text, num_turns: 1,
      modelUsage: { "claude-haiku-5-5": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 1, webSearchRequests: 0, costUSD: 0, contextWindow: 200000, maxOutputTokens: 8000 } },
    },
  ];
}
