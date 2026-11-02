/** @file Visible failures at the runtime boundary (Codex app-server or Claude Code). */

/** Base error for connection, protocol, compatibility, sign-in and model failures. */
export class AgentEngineError extends Error {
  /** Creates a named error and keeps an optional underlying cause. */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A runtime child that failed to start, exited or could not be written to. */
export class RuntimeConnectionError extends AgentEngineError {}

/** Malformed JSON-RPC messages or results the protocol does not allow. */
export class RuntimeProtocolError extends AgentEngineError {}

/** A serving runtime older than, or a different major from, what this library was built against. */
export class RuntimeCompatibilityError extends AgentEngineError {}

/**
 * Why a runtime update did not finish. Before anything ran: `invalid-version`,
 * `not-updatable`, `lookup-failed`, `incompatible-target`, `in-progress`. After
 * the installer ran: `installer-failed`, `version-mismatch`, `incompatible-result`,
 * and for Claude `sdk-check-failed`: the binary is in place, but the Agent SDK
 * could not open a session on it or the session reported another version.
 */
export type RuntimeUpdateFailure =
  | "invalid-version"
  | "not-updatable"
  | "lookup-failed"
  | "incompatible-target"
  | "in-progress"
  | "installer-failed"
  | "version-mismatch"
  | "incompatible-result"
  | "sdk-check-failed";

/**
 * A runtime update that did not finish. `from` is the version to roll back to,
 * and `to` is what the binary reports now, read after the installer ran.
 */
export class RuntimeUpdateError extends AgentEngineError {
  readonly from?: string;
  readonly to?: string;
  /** The version the update was aiming for. */
  readonly target?: string;
  /** The installer's exit code; null when it did not exit by itself. */
  readonly exitCode?: number | null;
  /** The end of what the installer printed. */
  readonly output?: string;
  /** The command that ran. */
  readonly command?: readonly string[];

  /** Creates the error with what is known so far. */
  constructor(
    readonly reason: RuntimeUpdateFailure,
    message: string,
    details: { from?: string; to?: string; target?: string; exitCode?: number | null; output?: string; command?: readonly string[] } = {},
  ) {
    super(message);
    this.from = details.from;
    this.to = details.to;
    this.target = details.target;
    this.exitCode = details.exitCode;
    this.output = details.output;
    this.command = details.command;
  }
}

/** The runtime is not signed in, or is signed in a way the caller refused (an API key). */
export class RuntimeAuthError extends AgentEngineError {}

/** The requested model, effort or speed is not in the runtime's catalogue. */
export class RuntimeModelUnavailableError extends AgentEngineError {}

/** The runtime answered with a different model than the one requested. */
export class RuntimeModelSubstitutionError extends AgentEngineError {
  /** Creates the error with both model identifiers and the runtime that chose. */
  constructor(
    readonly expectedModel: string,
    readonly actualModel: string,
    runtime = "Codex app-server",
  ) {
    super(`${runtime} selected ${actualModel}; ${expectedModel} was requested.`);
  }
}

/** A steer that the runtime would not add to the running turn (none running, or a compaction). */
export class SteerRejectedError extends AgentEngineError {}

/**
 * A rewind put the files back but the runtime did not drop the turns, so the
 * conversation still holds them. `files` says what was put back.
 */
export class ConversationRevertError extends AgentEngineError {
  constructor(
    readonly files: { paths: string[]; method?: "checkpoint" | "edits"; skipped?: string[] },
    cause: unknown,
  ) {
    super(`The files were put back, but the conversation was not rewound: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/** The runtime cannot do this; `Engine.capabilities()` lists what it can. */
export class UnsupportedFeatureError extends AgentEngineError {
  /** Creates the error for one feature on one runtime. */
  constructor(
    readonly feature: string,
    readonly provider: string,
    detail?: string,
  ) {
    super(`${provider} cannot ${feature}${detail ? `: ${detail}` : "."}`);
  }
}
