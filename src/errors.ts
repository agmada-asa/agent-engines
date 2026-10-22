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
