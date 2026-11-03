# Threads and history

## History, fork and rewind

A turn's ID is the one the runtime stores (on Claude, the prompt's UUID), so `history()` and `readThread()` give turns whose IDs `forkThread`, `rewind` and `interruptTurn` accept.

```ts
const turns = await thread.history(); // [{ id, status, entries: TranscriptEntry[] }]
const branch = await engine.forkThread(thread.id, { cwd, throughTurnId: turns[0].id });

// Edit an earlier prompt: rewind to before it, then send the new text.
await thread.rewind(turns[1].id, { files: true });
await thread.run("The edited prompt");
```

`listThreads({ cwd, search, limit, archived })` lists threads newest first, including ones started outside this library. `limit` defaults to 50, and `archived` (Codex) lists archived threads instead of active ones. Codex leaves subagents out.

### How files come back

`rewind` reports how it restored files as `files.method`:

- **`checkpoint`**: Claude's own file checkpoints (`fileCheckpoints: true`), or on Codex a git snapshot the engine takes before each turn when the thread has `fileCheckpoints` and its folder is in a git repository. The snapshot goes into git's object store through a temporary index, so branches, the index and the working tree are not touched, and its ID is kept under the repository's git folder. A rewind restores whatever changed in the thread's folder since then, including files a shell command wrote, and anyone else's edits there in the meantime. Untracked files over 10 MB are left out.
- **`edits`** (Codex without a snapshot): the edits Codex recorded in the dropped turns are undone, newest first. Files a shell command wrote are left as they are, and a file whose text has changed since is listed in `files.skipped`.

Files are put back before the conversation is rewound. If Codex then fails to drop the turns, `rewind` throws `ConversationRevertError`. Its `files` says what was put back, and the turns are still in the conversation, so tell the agent in the next prompt.

### Limits

- Codex itself only rewinds the conversation, and turns the agent starts on its own (a goal's follow-on turns) get no snapshot.
- Claude can't rewind past its first turn. Start a new thread instead.

## Plan mode and access per turn

`mode` and `access` work on the thread and on any turn, and a turn's choice sticks:

```ts
await thread.run("Plan the migration", { mode: "plan" }).result;
await thread.run("Go ahead", { mode: "default", access: "accept-edits" }).result;
```

On Claude, a new access level restarts the thread's process (the session is kept), because Claude Code only takes some of it at launch. A mode change does not.

The two runtimes end plan mode differently:

- **Claude** ends it with a `request` whose `action` is `plan` and whose `plan` is the proposal. Allow it to leave plan mode and carry the plan out, or deny it with a `message` to keep planning.
- **Codex** ends the turn with `plan.proposal.done`. Send the next turn with `mode: "default"` to go ahead.

## Structured output

```ts
const result = await thread.run("Classify this message", {
  outputSchema: {
    type: "object",
    properties: { kind: { enum: ["answer", "done", "blocked"] } },
    required: ["kind"],
  },
}).result;

result.output; // { kind: "answer" }, or undefined if the reply was not valid JSON
```

A schema on the thread applies to every turn. A turn's own schema wins, and `outputSchema: null` turns it off for one turn. Claude takes a schema per process, so changing it restarts the process before the turn.

## Files

`run({ text, images, files })` takes files by path or as base64.

- **Claude** reads PDFs and text files as documents.
- **Codex**, and anything Claude can't read, gets the paths named at the end of the message. Base64 files are saved to a temporary folder first.
- **ACP agents** get the content embedded where they accept it, otherwise a link.

Images go by path or base64 to every runtime. Claude's are read and sent as base64.

## Moving a conversation between runtimes

```ts
const transcript = await claudeThread.export();
const codexThread = await codex.startThread({ cwd, seed: transcript });
```

Codex adds the earlier conversation to the thread's history. Claude and ACP agents get it before the first message. Reasoning is left out and long tool output is shortened.
