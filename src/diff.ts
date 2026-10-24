/**
 * @file Unified diff text for file changes, so `FileChange.diff` has one shape
 * whichever runtime made the change.
 */

/** A whole file as one hunk: every line added (a new file) or removed (a deleted one). Empty for an empty file. */
export function wholeFileDiff(sign: "+" | "-", text: string): string {
  if (!text) return "";
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  const range = `0,0`;
  const span = `1,${lines.length}`;
  return [sign === "+" ? `@@ -${range} +${span} @@` : `@@ -${span} +${range} @@`, ...lines.map((line) => sign + line)].join("\n");
}

/** Hunks as `{ oldStart, oldLines, newStart, newLines, lines }` (the `diff` package's shape) as unified diff text. */
export function hunksDiff(hunks: ReadonlyArray<Record<string, any>>): string {
  return hunks
    .map((hunk) => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...(Array.isArray(hunk.lines) ? hunk.lines : [])].join("\n"))
    .join("\n");
}

/** Marks, while diffing, a last line that has no newline after it. */
const NO_NEWLINE = "\u0000";

/** Above this many line pairs a diff is one replace-everything hunk rather than an exact one. */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * Unified diff hunks between two texts, with three lines of context, in the same
 * shape as `wholeFileDiff`. For runtimes that report an edit as before-and-after
 * text (ACP agents).
 */
export function unifiedDiff(before: string, after: string, context = 3): string {
  if (before === after) return "";
  // A last line without a newline differs from the same line with one; a marker keeps them apart until output.
  const split = (text: string) => {
    if (!text) return [];
    const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
    if (!text.endsWith("\n")) lines[lines.length - 1] += NO_NEWLINE;
    return lines;
  };
  const a = split(before);
  const b = split(after);
  if (!a.length) return wholeFileDiff("+", after);
  if (!b.length) return wholeFileDiff("-", before);
  // Edit script from a longest-common-subsequence table: " " keep, "-" remove, "+" add.
  let ops: Array<[" " | "-" | "+", string]>;
  if (a.length * b.length > MAX_DIFF_CELLS) {
    ops = [...a.map((line) => ["-", line] as ["-", string]), ...b.map((line) => ["+", line] as ["+", string])];
  } else {
    const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    ops = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) ops.push([" ", a[i++]!]), j++;
      else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push(["-", a[i++]!]);
      else ops.push(["+", b[j++]!]);
    }
    while (i < a.length) ops.push(["-", a[i++]!]);
    while (j < b.length) ops.push(["+", b[j++]!]);
  }
  // Changes closer than twice the context share a hunk; each hunk keeps `context` unchanged lines either side.
  const changes = ops.flatMap(([op], index) => (op === " " ? [] : [index]));
  const hunks: string[] = [];
  let next = 0;
  while (next < changes.length) {
    let last = changes[next]!;
    let following = next + 1;
    while (following < changes.length && changes[following]! - last - 1 <= context * 2) last = changes[following++]!;
    const from = Math.max(0, changes[next]! - context);
    const to = Math.min(ops.length, last + 1 + context);
    const before = ops.slice(0, from);
    const oldStart = before.filter(([op]) => op !== "+").length + 1;
    const newStart = before.filter(([op]) => op !== "-").length + 1;
    const lines = ops.slice(from, to);
    const oldCount = lines.filter(([op]) => op !== "+").length;
    const newCount = lines.filter(([op]) => op !== "-").length;
    const body = lines.flatMap(([op, line]) => (line.endsWith(NO_NEWLINE) ? [op + line.slice(0, -NO_NEWLINE.length), "\\ No newline at end of file"] : [op + line]));
    hunks.push([`@@ -${oldCount ? oldStart : oldStart - 1},${oldCount} +${newCount ? newStart : newStart - 1},${newCount} @@`, ...body].join("\n"));
    next = following;
  }
  return hunks.join("\n");
}

