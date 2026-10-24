/** @file File rewind for Codex: git snapshots in real temporary repositories, and undoing recorded edits. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { CheckpointStore, gitRepository, restoreTree, reverseChanges, reverseDiff, snapshotTree } from "../src/checkpoints.ts";
import { CodexEngine } from "../src/codex/engine.ts";
import { ConversationRevertError } from "../src/errors.ts";
import { unifiedDiff, wholeFileDiff } from "../src/diff.ts";
import { FakeAppServer, fakeSpawner, until } from "./fake-app-server.ts";

const folders: string[] = [];
after(async () => {
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
});

async function folder(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `checkpoints-${name}-`));
  folders.push(dir);
  return dir;
}

/** A repository with one commit: tracked.txt and an ignored file. */
async function repository(): Promise<string> {
  const dir = await folder("repo");
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-q");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  await writeFile(join(dir, "tracked.txt"), "one\ntwo\n");
  await writeFile(join(dir, ".gitignore"), "ignored.log\n");
  run("add", ".");
  run("commit", "-qm", "start");
  return dir;
}

const exists = (path: string) => stat(path).then(() => true, () => false);

test("a snapshot restores changed, deleted and added files, and leaves ignored files and the index alone", async () => {
  const dir = await repository();
  await writeFile(join(dir, "draft.txt"), "untracked but kept\n");
  const tree = await snapshotTree(dir);
  assert.match(tree, /^[0-9a-f]{40}$/u);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }), "?? draft.txt\n", "the snapshot staged nothing");

  await writeFile(join(dir, "tracked.txt"), "one\nTWO\nthree\n");
  await rm(join(dir, "draft.txt"));
  await writeFile(join(dir, "new.txt"), "made by the agent\n");
  await writeFile(join(dir, "ignored.log"), "noise\n");

  const restored = await restoreTree(dir, tree);
  assert.deepEqual(restored.paths, [join(dir, "draft.txt"), join(dir, "new.txt"), join(dir, "tracked.txt")].sort());
  assert.equal(await readFile(join(dir, "tracked.txt"), "utf8"), "one\ntwo\n");
  assert.equal(await readFile(join(dir, "draft.txt"), "utf8"), "untracked but kept\n");
  assert.equal(await exists(join(dir, "new.txt")), false);
  assert.equal(await readFile(join(dir, "ignored.log"), "utf8"), "noise\n", "ignored files are not touched");
  assert.ok(restored.insertions >= 1 && restored.deletions >= 1);
});

test("a restore only touches the thread's folder", async () => {
  const dir = await repository();
  await mkdir(join(dir, "app"));
  await writeFile(join(dir, "app", "a.txt"), "a\n");
  const tree = await snapshotTree(join(dir, "app"));
  await writeFile(join(dir, "app", "a.txt"), "changed\n");
  await writeFile(join(dir, "elsewhere.txt"), "someone else's work\n");
  await restoreTree(join(dir, "app"), tree);
  assert.equal(await readFile(join(dir, "app", "a.txt"), "utf8"), "a\n");
  assert.equal(await readFile(join(dir, "elsewhere.txt"), "utf8"), "someone else's work\n");
});

test("snapshots work in a repository with no commits yet", async () => {
  const dir = await folder("fresh");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "a\n");
  const tree = await snapshotTree(dir);
  await writeFile(join(dir, "a.txt"), "b\n");
  await restoreTree(dir, tree);
  assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "a\n");
});

test("the checkpoint store keeps tree IDs in the git folder across opens", async () => {
  const dir = await repository();
  const store = (await CheckpointStore.open(dir, "thread-1"))!;
  await store.set("turn-1", "abc");
  assert.equal((await CheckpointStore.open(dir, "thread-1"))!.get("turn-1"), "abc");
  await store.forget(["turn-1"]);
  assert.equal((await CheckpointStore.open(dir, "thread-1"))!.get("turn-1"), undefined);
  assert.equal(await CheckpointStore.open(await folder("plain"), "thread-1"), undefined, "no store outside a repository");
  assert.equal(await gitRepository(await folder("plain2")), undefined);
});

test("reverseDiff undoes what unifiedDiff describes", () => {
  const cases: Array<[string, string]> = [
    ["a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", "a\nB\nc\nd\ne\nf\ng\nh\nI\nj\nk\n"],
    ["one\ntwo\n", "zero\none\ntwo\n"],
    ["one\ntwo\nthree\n", "one\nthree\n"],
    ["x\n", "x\ny\nz\n"],
  ];
  for (const [before, after] of cases) assert.equal(reverseDiff(after, unifiedDiff(before, after)), before, JSON.stringify([before, after]));
});

test("reverseDiff takes Codex's diffs, which end in a newline, including a hunk at the end of the file", () => {
  assert.equal(reverseDiff("a\nb\nC\n", "@@ -2,2 +2,2 @@\n b\n-c\n+C\n"), "a\nb\nc\n");
  assert.equal(reverseDiff("x\nC\ny\n", "@@ -1,2 +1,2 @@\n x\n-c\n+C\n"), "x\nc\ny\n");
  // An empty context line written without its leading space still counts.
  assert.equal(reverseDiff("a\n\nB\n", "@@ -1,3 +1,3 @@\n a\n\n-b\n+B\n"), "a\n\nb\n");
});

test("reverseDiff finds a hunk that moved, and refuses one that no longer matches", () => {
  const diff = unifiedDiff("a\nb\nc\n", "a\nB\nc\n");
  assert.equal(reverseDiff("header\nextra\na\nB\nc\n", diff), "header\nextra\na\nb\nc\n");
  assert.equal(reverseDiff("a\nsomething else\nc\n", diff), undefined);
});

test("reverseChanges undoes adds, deletes, updates and moves, newest first, and reports what it could not", async () => {
  const dir = await folder("edits");
  const added = join(dir, "added.txt");
  const deleted = join(dir, "deleted.txt");
  const updated = join(dir, "updated.txt");
  const moved = join(dir, "moved-from.txt");
  const movedTo = join(dir, "moved-to.txt");
  const drifted = join(dir, "drifted.txt");
  await writeFile(added, "new\n");
  await writeFile(updated, "a\nB\nc\n");
  await writeFile(movedTo, "x\nY\n");
  await writeFile(drifted, "rewritten by hand\n");
  const result = await reverseChanges([
    { path: added, kind: "add", diff: wholeFileDiff("+", "new\n") },
    { path: deleted, kind: "delete", diff: wholeFileDiff("-", "gone\nback\n") },
    { path: updated, kind: "update", diff: unifiedDiff("a\nb\nc\n", "a\nB\nc\n") },
    { path: moved, kind: "update", movedTo, diff: unifiedDiff("x\ny\n", "x\nY\n") },
    { path: drifted, kind: "update", diff: unifiedDiff("old\n", "agent text\n") },
  ]);
  assert.equal(await exists(added), false);
  assert.equal(await readFile(deleted, "utf8"), "gone\nback\n");
  assert.equal(await readFile(updated, "utf8"), "a\nb\nc\n");
  assert.equal(await readFile(moved, "utf8"), "x\ny\n");
  assert.equal(await exists(movedTo), false);
  assert.deepEqual(result.skipped, [drifted]);
  assert.deepEqual(result.paths, [added, deleted, moved, updated].sort());
});

/** A fake app-server whose turns the test finishes, with a turn history for rewind. */
function codexHandlers(history: () => unknown[]) {
  let turns = 0;
  return {
    "thread/start": () => ({ thread: { id: "t1" }, model: "gpt-6-luna" }),
    "thread/turns/list": () => ({ data: history(), nextCursor: null }),
    "thread/revert": () => ({}),
    "turn/start": (_params: any, server: FakeAppServer) => {
      turns += 1;
      const id = `turn-${turns}`;
      queueMicrotask(() => {
        server.notify("turn/started", { threadId: "t1", turn: { id, items: [], status: "inProgress" } });
        server.notify("turn/completed", { threadId: "t1", turn: { id, status: "completed", items: [], error: null } });
      });
      return { turn: { id, items: [], status: "inProgress" } };
    },
  };
}

test("Codex rewind with files restores the snapshot taken before the turn", async () => {
  const dir = await repository();
  const turnRecord = (id: string) => ({ id, status: "completed", items: [] });
  const { spawn } = fakeSpawner(codexHandlers(() => [turnRecord("turn-1"), turnRecord("turn-2")]));
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: dir, fileCheckpoints: true });
  await thread.run("first").result;
  // What the second turn did, by any means (a shell command, say).
  const second = thread.run("second");
  await second.id;
  await until(() => true);
  await second.result;
  await writeFile(join(dir, "tracked.txt"), "rewritten\n");
  await writeFile(join(dir, "made.txt"), "by a shell command\n");
  const result = await thread.rewind("turn-2", { files: true });
  assert.equal(result.droppedTurns, 1);
  assert.equal(result.files?.method, "checkpoint");
  assert.equal(await readFile(join(dir, "tracked.txt"), "utf8"), "one\ntwo\n");
  assert.equal(await exists(join(dir, "made.txt")), false);
  assert.equal((await CheckpointStore.open(dir, "t1"))!.get("turn-2"), undefined, "the dropped turn's snapshot is forgotten");
  await engine.close();
});

test("Codex rewind puts the files back even when the conversation does not rewind, and the error says so", async () => {
  const dir = await repository();
  const turnRecord = (id: string) => ({ id, status: "completed", items: [] });
  const { spawn } = fakeSpawner({
    ...codexHandlers(() => [turnRecord("turn-1"), turnRecord("turn-2")]),
    "thread/revert": () => {
      throw new Error("revert refused");
    },
  });
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: dir, fileCheckpoints: true });
  await thread.run("first").result;
  await thread.run("second").result;
  await writeFile(join(dir, "tracked.txt"), "rewritten\n");
  const error = await thread.rewind("turn-2", { files: true }).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof ConversationRevertError, String(error));
  assert.match(error.message, /files were put back, but the conversation was not rewound: .*revert refused/u);
  assert.equal(error.files.method, "checkpoint");
  assert.deepEqual(error.files.paths, [join(dir, "tracked.txt")]);
  assert.equal(await readFile(join(dir, "tracked.txt"), "utf8"), "one\ntwo\n");
  // The turns are still there, so their snapshots are kept.
  assert.ok((await CheckpointStore.open(dir, "t1"))!.get("turn-2"));
  await engine.close();
});

test("Codex rewind with files undoes recorded edits when there is no snapshot", async () => {
  const dir = await folder("codex-edits");
  const file = join(dir, "notes.txt");
  await writeFile(file, "a\nB\nc\n");
  await writeFile(join(dir, "new.txt"), "hello\n");
  const history = () => [
    { id: "turn-1", status: "completed", items: [] },
    { id: "turn-2", status: "completed", items: [
      { type: "fileChange", id: "f1", status: "completed", changes: [{ path: file, kind: { type: "update", move_path: null }, diff: unifiedDiff("a\nb\nc\n", "a\nB\nc\n") }] },
      { type: "fileChange", id: "f2", status: "completed", changes: [{ path: join(dir, "new.txt"), kind: { type: "add" }, diff: "hello\n" }] },
    ] },
  ];
  const { spawn } = fakeSpawner(codexHandlers(history));
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: dir });
  const result = await thread.rewind("turn-2", { files: true });
  assert.deepEqual(result.files, { paths: [join(dir, "new.txt"), file].sort(), method: "edits" });
  assert.equal(await readFile(file, "utf8"), "a\nb\nc\n");
  assert.equal(await exists(join(dir, "new.txt")), false);
  await engine.close();
});
