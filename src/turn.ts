/**
 * @file The `Turn` both engines hand out: a buffered event queue that can be
 * iterated once, plus `steer`, `interrupt` and a `result` that never rejects.
 * Engines push normalised events and call `finish` exactly once.
 */

import type { AgentEvent, Turn, TurnInput, TurnResult } from "./types.ts";

/** What an engine supplies to control its own turn. */
export interface TurnControls {
  steer(input: TurnInput): Promise<void>;
  interrupt(): Promise<void>;
}

/** Internal turn: engines push events into it and settle it. */
export class TurnHandle implements Turn {
  readonly id: Promise<string>;
  readonly result: Promise<TurnResult>;
  private resolveId!: (id: string) => void;
  private resolveResult!: (result: TurnResult) => void;
  private readonly queue: AgentEvent[] = [];
  private waiting?: () => void;
  private finished = false;
  private iterated = false;
  private knownId?: string;
  /** Whether this turn asked for structured output, so its reply is parsed into `output`. */
  expectsOutput = false;

  constructor(
    readonly threadId: string,
    private readonly controls: TurnControls,
  ) {
    this.id = new Promise((resolve) => (this.resolveId = resolve));
    this.result = new Promise((resolve) => (this.resolveResult = resolve));
  }

  /** The turn ID once known; engines use it to route events. */
  get turnId(): string | undefined {
    return this.knownId;
  }

  /** Whether the turn has settled. */
  get done(): boolean {
    return this.finished;
  }

  /** Records the runtime's turn ID; later calls are ignored. */
  setId(id: string): void {
    if (this.knownId) return;
    this.knownId = id;
    this.resolveId(id);
  }

  /** Queues one event for the iterator. Events after `finish` are dropped. */
  push(event: AgentEvent): void {
    if (this.finished) return;
    this.queue.push(event);
    this.wake();
  }

  /** Settles the turn. The iterator drains what is queued, then ends. */
  finish(result: TurnResult): void {
    if (this.finished) return;
    this.setId(result.turnId);
    this.finished = true;
    this.resolveResult(result);
    this.wake();
  }

  steer(input: TurnInput): Promise<void> {
    return this.controls.steer(input);
  }

  interrupt(): Promise<void> {
    return this.controls.interrupt();
  }

  /** Iterates the turn's events. A turn can be iterated once; `result` works either way. */
  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    if (this.iterated) throw new Error("A turn's events can only be iterated once.");
    this.iterated = true;
    for (;;) {
      const event = this.queue.shift();
      if (event) {
        yield event;
        continue;
      }
      if (this.finished) return;
      await new Promise<void>((resolve) => (this.waiting = resolve));
    }
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.();
  }
}

/** Splits a turn input into text, images and files. */
export function inputParts(input: TurnInput): {
  text: string;
  images: NonNullable<Exclude<TurnInput, string>["images"]>;
  files: NonNullable<Exclude<TurnInput, string>["files"]>;
} {
  return typeof input === "string" ? { text: input, images: [], files: [] } : { text: input.text, images: input.images ?? [], files: input.files ?? [] };
}

/** Puts `prefix` before a turn input's text, keeping its images and files. */
export function prefixInput(input: TurnInput, prefix: string): TurnInput {
  if (!prefix) return input;
  return typeof input === "string" ? prefix + input : { ...input, text: prefix + input.text };
}

/**
 * A structured reply, parsed: the text as JSON, or the first fenced JSON block
 * in it. Undefined when neither parses.
 */
export function parseOutput(text: string): unknown {
  const attempts = [text.trim(), /```(?:json)?\s*([\s\S]*?)```/u.exec(text)?.[1]?.trim()];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      return JSON.parse(attempt);
    } catch {
      // Try the next form.
    }
  }
  return undefined;
}

/** Delivers an event to thread listeners, isolating listener failures. */
export function emitTo(listeners: Iterable<(event: AgentEvent) => void>, event: AgentEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A consumer's listener must not break the engine.
    }
  }
}
