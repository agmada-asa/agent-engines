/** @file Unit tests for the host-side helpers: diffs, file search and reads, parsing, handoff rendering and review prompts. */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { unifiedDiff, wholeFileDiff } from "../src/diff.ts";
import { attachedFilesNote, fuzzyScore, isTextMedia, localFileSearch, mediaTypeOf, readFileInput, saveAttachment } from "../src/files.ts";
import { renderTranscript, responsesItems, seedPreamble } from "../src/handoff.ts";
import { reviewPrompt } from "../src/review.ts";
import { inputParts, parseOutput, prefixInput } from "../src/turn.ts";
import type { PortableTranscript, ReviewTarget } from "../src/types.ts";

const run = promisify(execFile);
const folders: string[] = [];

/** A fresh temporary folder, removed when the file's tests finish. */
async function folder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "helpers-test-"));
  folders.push(dir);
  return dir;
}

after(async () => {
  for (const dir of folders) await rm(dir, { recursive: true, force: true });
});

/** Ten lines, "1" to "10". */
const TEN = Array.from({ length: 10 }, (_, i) => String(i + 1)).join("\n") + "\n";
/** Twenty lines, "1" to "20". */
const TWENTY = Array.from({ length: 20 }, (_, i) => String(i + 1)).join("\n") + "\n";

// unifiedDiff

test("unifiedDiff of identical texts is empty", () => {
  assert.equal(unifiedDiff(TEN, TEN), "");
  assert.equal(unifiedDiff("", ""), "");
});

test("unifiedDiff: a one-line change in the middle has three lines of context, as diff -U3 prints it", () => {
  const after = TEN.replace("6\n", "SIX\n");
  assert.equal(unifiedDiff(TEN, after), "@@ -3,7 +3,7 @@\n 3\n 4\n 5\n-6\n+SIX\n 7\n 8\n 9");
});

test("unifiedDiff: an append at the end", () => {
  assert.equal(unifiedDiff(TEN, TEN + "11\n"), "@@ -8,3 +8,4 @@\n 8\n 9\n 10\n+11");
});

test("unifiedDiff: two changes far apart make two hunks", () => {
  const after = TWENTY.replace("2\n", "B\n").replace("19\n", "S\n");
  assert.equal(unifiedDiff(TWENTY, after), [
    "@@ -1,5 +1,5 @@", " 1", "-2", "+B", " 3", " 4", " 5",
    "@@ -16,5 +16,5 @@", " 16", " 17", " 18", "-19", "+S", " 20",
  ].join("\n"));
});

test("unifiedDiff: two changes within 6 lines make one hunk", () => {
  const after = TWENTY.replace("5\n", "FIVE\n").replace("9\n", "NINE\n");
  assert.equal(unifiedDiff(TWENTY, after), [
    "@@ -2,11 +2,11 @@", " 2", " 3", " 4", "-5", "+FIVE", " 6", " 7", " 8", "-9", "+NINE", " 10", " 11", " 12",
  ].join("\n"));
});

test("unifiedDiff: changes six unchanged lines apart make one hunk, as diff -U3 does", () => {
  const after = TWENTY.replace("2\n", "B\n").replace("9\n", "NINE\n");
  assert.equal(unifiedDiff(TWENTY, after), [
    "@@ -1,12 +1,12 @@", " 1", "-2", "+B", " 3", " 4", " 5", " 6", " 7", " 8", "-9", "+NINE", " 10", " 11", " 12",
  ].join("\n"));
});

test("unifiedDiff: changes seven unchanged lines apart make two hunks, as diff -U3 does", () => {
  const after = TWENTY.replace("1\n", "X\n").replace("9\n", "NINE\n");
  assert.equal(unifiedDiff(TWENTY, after), [
    "@@ -1,4 +1,4 @@", "-1", "+X", " 2", " 3", " 4",
    "@@ -6,7 +6,7 @@", " 6", " 7", " 8", "-9", "+NINE", " 10", " 11", " 12",
  ].join("\n"));
});

test("unifiedDiff: a change to the final newline alone is marked, as diff -U3 does", () => {
  assert.equal(unifiedDiff("a\nb", "a\nb\n"), ["@@ -1,2 +1,2 @@", " a", "-b", "\\ No newline at end of file", "+b"].join("\n"));
  assert.equal(unifiedDiff("a\n", "a"), ["@@ -1,1 +1,1 @@", "-a", "+a", "\\ No newline at end of file"].join("\n"));
});

test("unifiedDiff: an empty before is a whole-file add", () => {
  const text = "hello\nworld\n";
  assert.equal(unifiedDiff("", text), wholeFileDiff("+", text));
  assert.equal(unifiedDiff("", text), "@@ -0,0 +1,2 @@\n+hello\n+world");
});

test("unifiedDiff: an empty after is a whole-file delete", () => {
  const text = "hello\nworld\n";
  assert.equal(unifiedDiff(text, ""), wholeFileDiff("-", text));
  assert.equal(unifiedDiff(text, ""), "@@ -1,2 +0,0 @@\n-hello\n-world");
});

// fuzzyScore

test("fuzzyScore: no match when a query character is missing or out of order", () => {
  assert.equal(fuzzyScore("xyz", "src/app.ts"), undefined);
  assert.equal(fuzzyScore("tsa", "src/app.ts"), undefined);
});

test("fuzzyScore: a file-name prefix outranks a scattered match", () => {
  const prefix = fuzzyScore("app", "src/app.ts")!;
  const scattered = fuzzyScore("app", "src/a/p/p/l.ts")!;
  assert.ok(prefix.score > scattered.score, `${prefix.score} should beat ${scattered.score}`);
});

test("fuzzyScore: matched indices point at the matched characters", () => {
  assert.deepEqual(fuzzyScore("ap", "src/app.ts")!.indices, [4, 5]);
  assert.deepEqual(fuzzyScore("sa", "src/app.ts")!.indices, [0, 4]);
  assert.deepEqual(fuzzyScore("a p", "src/app.ts")!.indices, [4, 5]);
});

test("fuzzyScore: case-insensitive, with the same indices", () => {
  assert.deepEqual(fuzzyScore("APP", "src/app.ts")!.indices, [4, 5, 6]);
  assert.deepEqual(fuzzyScore("app", "SRC/APP.TS")!.indices, [4, 5, 6]);
});

// localFileSearch

test("localFileSearch outside a repository skips node_modules and .git, sorts best first and respects limit", async () => {
  const dir = await folder();
  for (const path of ["app.ts", "src/app/index.ts", "src/tools/map.ts", "node_modules/app/index.js", ".git/app.ts", "dist/app.js"]) {
    await mkdir(join(dir, dirname(path)), { recursive: true });
    await writeFile(join(dir, path), "x");
  }
  const results = await localFileSearch("app", dir);
  assert.deepEqual(results.map((match) => match.path), ["app.ts", "src/app/index.ts"]);
  assert.ok(results[0]!.score >= results[1]!.score);
  assert.deepEqual(results[0]!.indices, [0, 1, 2]);
  assert.equal((await localFileSearch("app", dir, 1)).length, 1);
});

test("localFileSearch: limit keeps only the best matches", async () => {
  const dir = await folder();
  for (const name of ["file1.ts", "file2.ts", "file3.ts", "file4.ts", "file5.ts"]) await writeFile(join(dir, name), "x");
  const all = await localFileSearch("file", dir);
  assert.equal(all.length, 5);
  const top = await localFileSearch("file", dir, 2);
  assert.deepEqual(top.map((match) => match.path), all.slice(0, 2).map((match) => match.path));
});

test("localFileSearch needs an absolute cwd", async () => {
  await assert.rejects(localFileSearch("app", "relative/folder"), /absolute cwd/);
});

test("localFileSearch in a repository leaves out ignored files and keeps untracked ones", async () => {
  const dir = await folder();
  await run("git", ["init", "-q"], { cwd: dir });
  await writeFile(join(dir, ".gitignore"), "secret.log\n");
  await writeFile(join(dir, "secret.log"), "x");
  await writeFile(join(dir, "notes.md"), "x");
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "app.ts"), "x");
  const paths = (await localFileSearch("", dir, 100)).map((match) => match.path);
  assert.ok(paths.includes("notes.md"));
  assert.ok(paths.includes("src/app.ts"));
  assert.ok(!paths.includes("secret.log"));
});

// Media types and files

test("mediaTypeOf reads the extension, ignoring case, and falls back to octet-stream", () => {
  assert.equal(mediaTypeOf("/docs/Report.PDF"), "application/pdf");
  assert.equal(mediaTypeOf("photo.jpeg"), "image/jpeg");
  assert.equal(mediaTypeOf("notes.md"), "text/markdown");
  assert.equal(mediaTypeOf("archive.zip"), "application/octet-stream");
  assert.equal(mediaTypeOf("Makefile"), "application/octet-stream");
});

test("isTextMedia is true for text and structured text, false for binary", () => {
  assert.equal(isTextMedia("text/plain"), true);
  assert.equal(isTextMedia("application/json"), true);
  assert.equal(isTextMedia("application/xml"), true);
  assert.equal(isTextMedia("application/yaml"), true);
  assert.equal(isTextMedia("application/pdf"), false);
  assert.equal(isTextMedia("image/png"), false);
});

test("readFileInput decodes base64 data", async () => {
  const file = await readFileInput({ type: "base64", name: "n.txt", mediaType: "text/plain", data: Buffer.from("hi").toString("base64") });
  assert.deepEqual(file, { name: "n.txt", mediaType: "text/plain", data: Buffer.from("hi") });
});

test("readFileInput reads a path, taking the name and media type from it unless given", async () => {
  const dir = await folder();
  const path = join(dir, "notes.md");
  await writeFile(path, "# hi");
  assert.deepEqual(await readFileInput({ type: "path", path }), { name: "notes.md", mediaType: "text/markdown", data: Buffer.from("# hi"), path });
  const named = await readFileInput({ type: "path", path, name: "Renamed.txt", mediaType: "text/plain" });
  assert.equal(named.name, "Renamed.txt");
  assert.equal(named.mediaType, "text/plain");
});

test("readFileInput needs an absolute path", async () => {
  await assert.rejects(readFileInput({ type: "path", path: "notes.md" }), /absolute path/);
});

test("attachedFilesNote lists paths, or is empty when there are none", () => {
  assert.equal(attachedFilesNote([]), "");
  assert.equal(attachedFilesNote(["/a/b.pdf", "/c.txt"]), "\n\nAttached files:\n- /a/b.pdf\n- /c.txt");
});

test("saveAttachment writes the bytes under a sanitised name", async () => {
  const path = await saveAttachment("../../my file (1).txt", Buffer.from("bytes"));
  try {
    assert.equal(dirname(path), join(tmpdir(), "agent-engines", "attachments"));
    assert.ok(basename(path).endsWith("-.._.._my_file__1_.txt"), basename(path));
    assert.deepEqual(await readFile(path), Buffer.from("bytes"));
  } finally {
    await rm(path, { force: true });
  }
});

// Turn helpers

test("parseOutput reads plain JSON, JSON in a fenced block inside prose, and gives undefined for invalid text", () => {
  assert.deepEqual(parseOutput('{"ok": true, "n": 2}'), { ok: true, n: 2 });
  assert.deepEqual(parseOutput('Here is the result:\n```json\n{"ok": true}\n```\nLet me know.'), { ok: true });
  assert.equal(parseOutput("not json"), undefined);
  assert.equal(parseOutput("```json\nnot json\n```"), undefined);
});

test("prefixInput puts the prefix before a string or an object's text, keeping images and files", () => {
  assert.equal(prefixInput("hello", "Context: "), "Context: hello");
  assert.equal(prefixInput("hello", ""), "hello");
  const input = { text: "look", images: [{ type: "path" as const, path: "/a.png" }], files: [{ type: "path" as const, path: "/b.pdf" }] };
  assert.deepEqual(prefixInput(input, "Ctx\n\n"), { text: "Ctx\n\nlook", images: input.images, files: input.files });
});

test("inputParts defaults images and files to empty lists", () => {
  assert.deepEqual(inputParts("hi"), { text: "hi", images: [], files: [] });
  assert.deepEqual(inputParts({ text: "hi" }), { text: "hi", images: [], files: [] });
  assert.deepEqual(inputParts({ text: "hi", images: [{ type: "path", path: "/a.png" }] }).files, []);
});

// Handoff

const transcript = (turns: PortableTranscript["turns"], provider: PortableTranscript["provider"] = "codex"): PortableTranscript => ({ provider, threadId: "thread-1", turns });

test("renderTranscript writes user and assistant lines, tool calls and changed files, and leaves reasoning out", () => {
  const text = renderTranscript(transcript([
    {
      id: "t1", status: "completed", entries: [
        { kind: "message", role: "user", text: "List files" },
        { kind: "reasoning", text: "I should run ls" },
        { kind: "tool", tool: { kind: "command", name: "Bash", input: { command: "ls" } }, output: "a.txt\nb.txt" },
        { kind: "message", role: "assistant", text: "There are two files." },
        { kind: "files", changes: [{ path: "/a/b.ts", kind: "update" }, { path: "/a/new.ts", kind: "add" }] },
      ],
    },
  ]));
  assert.equal(text, "User: List files\n[tool Bash] {\"command\":\"ls\"}\na.txt\nb.txt\nAssistant: There are two files.\n[changed files] update /a/b.ts, add /a/new.ts");
  assert.ok(!text.includes("I should run ls"));
});

test("renderTranscript cuts tool output over 2000 characters and marks failed calls", () => {
  const long = "y".repeat(2500);
  const text = renderTranscript(transcript([{ id: "t1", status: "completed", entries: [{ kind: "tool", tool: { kind: "builtin", name: "Read", input: "/x" }, output: long, isError: true }] }]));
  assert.equal(text, `[tool Read failed] /x\n${"y".repeat(2000)}…`);
  const exact = "z".repeat(2000);
  const kept = renderTranscript(transcript([{ id: "t1", status: "completed", entries: [{ kind: "tool", tool: { kind: "builtin", name: "Read", input: {} }, output: exact }] }]));
  assert.equal(kept, `[tool Read] {}\n${exact}`);
});

test("renderTranscript of a transcript with only reasoning is empty", () => {
  assert.equal(renderTranscript(transcript([{ id: "t1", status: "completed", entries: [{ kind: "reasoning", text: "thinking" }] }])), "");
});

test("seedPreamble is empty for an empty transcript", () => {
  assert.equal(seedPreamble(transcript([])), "");
  assert.equal(seedPreamble(transcript([{ id: "t1", status: "completed", entries: [{ kind: "reasoning", text: "x" }] }])), "");
});

test("seedPreamble wraps the rendered conversation and asks the agent to carry on", () => {
  const preamble = seedPreamble(transcript([{ id: "t1", status: "completed", entries: [
    { kind: "message", role: "user", text: "hi" },
    { kind: "message", role: "assistant", text: "hello" },
  ] }], "claude"));
  assert.equal(preamble, [
    "This conversation continues one held with another agent (claude). Here it is so far:",
    "<earlier-conversation>",
    "User: hi\nAssistant: hello",
    "</earlier-conversation>",
    "",
    "Carry on from there. The next message is the user's.",
    "",
  ].join("\n"));
});

test("responsesItems maps user and assistant messages, and renders tool and file entries as assistant output", () => {
  const items = responsesItems(transcript([{ id: "t1", status: "completed", entries: [
    { kind: "message", role: "user", text: "hi" },
    { kind: "reasoning", text: "skip me" },
    { kind: "tool", tool: { kind: "command", name: "Bash", input: { command: "ls" } }, output: "ok" },
    { kind: "message", role: "assistant", text: "hello" },
    { kind: "files", changes: [{ path: "/a.ts", kind: "update" }] },
  ] }]));
  assert.deepEqual(items, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "[tool Bash] {\"command\":\"ls\"}\nok" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "[changed files] update /a.ts" }] },
  ]);
});

// Review prompts

test("reviewPrompt for uncommitted changes names the status and diff commands and forbids changes", () => {
  const prompt = reviewPrompt({ type: "uncommitted" });
  assert.match(prompt, /`git status`, `git diff HEAD`/);
  assert.match(prompt, /Do not change any files\./);
});

test("reviewPrompt for a base branch names the branch diff and forbids changes", () => {
  const prompt = reviewPrompt({ type: "base-branch", branch: "main" });
  assert.match(prompt, /`git diff main\.\.\.HEAD`/);
  assert.match(prompt, /Do not change any files\./);
});

test("reviewPrompt for a commit names the commit, its title and git show, and forbids changes", () => {
  const prompt = reviewPrompt({ type: "commit", sha: "abc123", title: "Fix parser" });
  assert.match(prompt, /commit abc123 \(Fix parser\) \(`git show abc123`\)/);
  assert.match(prompt, /Do not change any files\./);
  assert.match(reviewPrompt({ type: "commit", sha: "abc123" }), /^Review commit abc123 \(`git show abc123`\)\./);
});

test("reviewPrompt for custom instructions includes them and forbids changes", () => {
  const target: ReviewTarget = { type: "custom", instructions: "Only look at the parser." };
  const prompt = reviewPrompt(target);
  assert.match(prompt, /^Review the code described below\.\n\nOnly look at the parser\./);
  assert.match(prompt, /Do not change any files\./);
  assert.ok(!prompt.includes("`git"));
});
