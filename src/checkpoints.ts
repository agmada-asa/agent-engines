/**
 * @file Putting files back for runtimes that rewind only the conversation
 * (Codex), in two ways:
 *
 * - **Snapshots.** Before each turn, the folder's state is written into git's
 *   object store as a tree, through a temporary index, so branches, the real
 *   index and the working tree are untouched (the way Codex's old `/undo`
 *   worked). A rewind restores what changed since the snapshot. Needs a git
 *   repository; the tree IDs are kept in the repository's git folder.
 * - **Reversed edits.** Without a snapshot, the edits the runtime recorded for
 *   the dropped turns are undone, newest first. Files a shell command wrote are
 *   not recorded, so they stay as they are.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentEngineError } from "./errors.ts";
import type { FileChange } from "./types.ts";

/** Untracked files larger than this are left out of a snapshot, as Codex did. */
const MAX_SNAPSHOT_FILE_BYTES = 10 * 1024 * 1024;

/** Runs git in `cwd`; rejects with its stderr. Paths are literal, so a file named `[id].tsx` is not a glob. */
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: { ...env, GIT_LITERAL_PATHSPECS: "1" }, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new AgentEngineError(`git ${args[0]} failed: ${String(stderr || error.message).trim()}`, { cause: error }));
      else resolve(stdout);
    });
  });
}

/** The repository `cwd` is in: its top folder and git folder. Undefined outside one, or without git. */
export async function gitRepository(cwd: string): Promise<{ top: string; gitDir: string } | undefined> {
  const output = await git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]).catch(() => undefined);
  const [top, gitDir] = output?.trim().split("\n") ?? [];
  return top && gitDir ? { top, gitDir } : undefined;
}

/**
 * Writes the state of the repository around `cwd` (tracked files as they are
 * now, plus untracked files git does not ignore) to git's object store and
 * returns the tree's ID. Nothing else in the repository changes.
 */
export async function snapshotTree(cwd: string): Promise<string> {
  const repository = await gitRepository(cwd);
  if (!repository) throw new AgentEngineError(`${cwd} is not in a git repository.`);
  const index = join(tmpdir(), `agent-engines-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    const head = await git(repository.top, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "");
    if (head.trim()) await git(repository.top, ["read-tree", "HEAD"], env);
    await git(repository.top, ["add", "-u"], env);
    const untracked = (await git(repository.top, ["ls-files", "--others", "--exclude-standard", "-z"], env)).split("\0").filter(Boolean);
    const small: string[] = [];
    for (const path of untracked) {
      const size = await stat(join(repository.top, path)).then((entry) => entry.size, () => Infinity);
      if (size <= MAX_SNAPSHOT_FILE_BYTES) small.push(path);
    }
    for (let start = 0; start < small.length; start += 500) await git(repository.top, ["add", "--", ...small.slice(start, start + 500)], env);
    return (await git(repository.top, ["write-tree"], env)).trim();
  } finally {
    await rm(index, { force: true });
  }
}

/**
 * Puts the files under `cwd` back as they were in snapshot `tree`: changed and
 * deleted files are restored, files added since are removed. Only what differs
 * is touched, but that includes anyone's changes in the folder since the
 * snapshot, not only the agent's.
 */
export async function restoreTree(cwd: string, tree: string): Promise<{ paths: string[]; insertions: number; deletions: number }> {
  const repository = await gitRepository(cwd);
  if (!repository) throw new AgentEngineError(`${cwd} is not in a git repository.`);
  const now = await snapshotTree(cwd);
  // Git's own view of where `cwd` sits, which survives symlinked paths such as macOS's /var.
  const prefix = (await git(cwd, ["rev-parse", "--show-prefix"])).trim();
  const scope = prefix || ".";
  const status = (await git(repository.top, ["diff", "--no-renames", "--name-status", "-z", tree, now, "--", scope])).split("\0").filter(Boolean);
  const restore: string[] = [];
  const remove: string[] = [];
  for (let index = 0; index + 1 < status.length; index += 2) {
    (status[index] === "A" ? remove : restore).push(status[index + 1]!);
  }
  let insertions = 0;
  let deletions = 0;
  for (const line of (await git(repository.top, ["diff", "--no-renames", "--numstat", now, tree, "--", scope])).split("\n")) {
    const [added, removed] = line.split("\t");
    if (added && added !== "-") insertions += Number(added);
    if (removed && removed !== "-") deletions += Number(removed);
  }
  for (let start = 0; start < restore.length; start += 500) {
    await git(repository.top, ["restore", `--source=${tree}`, "--worktree", "--", ...restore.slice(start, start + 500)]);
  }
  for (const path of remove) await rm(join(repository.top, path), { force: true });
  return { paths: [...restore, ...remove].map((path) => join(cwd, path.slice(prefix.length))).sort(), insertions, deletions };
}

/** Snapshot tree IDs by turn for one thread, kept in the repository's git folder so they outlive the process. */
export class CheckpointStore {
  private constructor(private readonly path: string, private readonly trees: Record<string, string>) {}

  /** The store for `threadId` in the repository around `cwd`, or undefined outside one. */
  static async open(cwd: string, threadId: string): Promise<CheckpointStore | undefined> {
    const repository = await gitRepository(cwd);
    if (!repository || !/^[A-Za-z0-9_-]{1,128}$/u.test(threadId)) return undefined;
    const path = join(repository.gitDir, "agent-engines", "checkpoints", `${threadId}.json`);
    const trees = await readFile(path, "utf8").then((text) => JSON.parse(text) as Record<string, string>, () => ({}));
    return new CheckpointStore(path, trees);
  }

  get(turnId: string): string | undefined {
    return this.trees[turnId];
  }

  async set(turnId: string, tree: string): Promise<void> {
    this.trees[turnId] = tree;
    await this.save();
  }

  async forget(turnIds: Iterable<string>): Promise<void> {
    for (const turnId of turnIds) delete this.trees[turnId];
    await this.save();
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.trees));
  }
}

/** One parsed hunk of a unified diff. */
interface Hunk {
  newStart: number;
  lines: Array<{ op: " " | "-" | "+"; text: string }>;
}

/**
 * Parses `@@ -a,b +c,d @@` hunks, reading only as many lines as each header
 * counts, so a diff's trailing newline is not taken for an empty context line.
 * The no-newline marker is skipped.
 */
function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split("\n")) {
    const header = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (header) {
      hunks.push({ newStart: Number(header[2]), lines: [] });
      oldLeft = header[1] === undefined ? 1 : Number(header[1]);
      newLeft = header[3] === undefined ? 1 : Number(header[3]);
      continue;
    }
    const hunk = hunks[hunks.length - 1];
    if (!hunk || line.startsWith("\\") || (oldLeft <= 0 && newLeft <= 0)) continue;
    // Some tools write an empty context line without its leading space.
    const op = line === "" ? " " : line[0];
    if (op === " " || op === "-") oldLeft -= 1;
    if (op === " " || op === "+") newLeft -= 1;
    if (op === " " || op === "-" || op === "+") hunk.lines.push({ op, text: line.slice(1) });
  }
  return hunks;
}

/**
 * Undoes a unified diff on the text it produced: each hunk's new lines are
 * found (at their line number, else the nearest exact match) and replaced by
 * the old ones. Undefined when a hunk does not match.
 */
export function reverseDiff(text: string, diff: string): string | undefined {
  const trailingNewline = text.endsWith("\n");
  const lines = text === "" ? [] : (trailingNewline ? text.slice(0, -1) : text).split("\n");
  // Last hunk first, so earlier line numbers stay right.
  for (const hunk of parseHunks(diff).reverse()) {
    const after = hunk.lines.filter((line) => line.op !== "-").map((line) => line.text);
    const before = hunk.lines.filter((line) => line.op !== "+").map((line) => line.text);
    const matches = (at: number) => after.every((line, offset) => lines[at + offset] === line);
    const expected = Math.max(0, hunk.newStart - (after.length ? 1 : 0));
    let at = -1;
    for (let distance = 0; distance <= lines.length; distance += 1) {
      if (expected - distance >= 0 && matches(expected - distance)) at = expected - distance;
      else if (expected + distance <= lines.length - after.length && matches(expected + distance)) at = expected + distance;
      if (at >= 0) break;
    }
    if (at < 0) return undefined;
    lines.splice(at, after.length, ...before);
  }
  return lines.length ? lines.join("\n") + (trailingNewline || !text ? "\n" : "") : "";
}

/**
 * Undoes file changes, given newest first: an added file is removed, a deleted
 * one written back from its diff, a moved one moved back, an update reversed.
 * Files whose current text no longer matches the change are skipped.
 */
export async function reverseChanges(changes: readonly FileChange[]): Promise<{ paths: string[]; skipped: string[] }> {
  const paths = new Set<string>();
  const skipped = new Set<string>();
  for (const change of changes) {
    try {
      if (change.kind === "add") {
        await rm(change.path, { force: true });
      } else if (change.kind === "delete") {
        const text = parseHunks(change.diff ?? "").flatMap((hunk) => hunk.lines.filter((line) => line.op === "-").map((line) => line.text));
        await mkdir(dirname(change.path), { recursive: true });
        await writeFile(change.path, text.length ? `${text.join("\n")}\n` : "");
      } else {
        const source = change.movedTo ?? change.path;
        const current = await readFile(source, "utf8");
        const restored = change.diff ? reverseDiff(current, change.diff) : current;
        if (restored === undefined) {
          skipped.add(change.path);
          continue;
        }
        await writeFile(source, restored);
        if (change.movedTo) {
          await mkdir(dirname(change.path), { recursive: true });
          await rename(change.movedTo, change.path);
        }
      }
      paths.add(change.path);
    } catch {
      skipped.add(change.path);
    }
  }
  return { paths: [...paths].filter((path) => !skipped.has(path)).sort(), skipped: [...skipped].sort() };
}
