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
