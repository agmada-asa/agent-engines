/**
 * @file Files on the host's side of a turn: a fuzzy search of a folder for `@`
 * mentions (for runtimes without their own index), and reading the files a
 * turn attaches into the form a runtime takes.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { AgentEngineError } from "./errors.ts";
import type { FileInput, FileMatch } from "./types.ts";

/** Folders a plain walk skips: dependencies, build output and VCS data. */
const SKIPPED_FOLDERS = new Set([".git", "node_modules", "dist", "build", ".next", "target", ".venv", "venv", "__pycache__", ".cache", ".turbo", "coverage"]);

/** Most files a search looks at, so a huge folder cannot stall it. */
const MAX_FILES = 50_000;

/** Lists the files under `cwd`, relative to it: git's view when it is a repository (ignored files left out), else a walk. */
export async function listFolderFiles(cwd: string): Promise<string[]> {
  const tracked = await gitFiles(cwd);
  if (tracked) return tracked.slice(0, MAX_FILES);
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (files.length >= MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) await walk(path);
      } else if (entry.isFile()) {
        files.push(relative(cwd, path).split(sep).join("/"));
      }
    }
  };
  await walk(cwd);
  return files;
}

/** `git ls-files` for tracked and untracked-but-not-ignored files; undefined outside a repository. */
function gitFiles(cwd: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(undefined);
      resolve(stdout.split("\0").filter(Boolean));
    });
  });
}

/**
 * Scores `path` against `query` as a fuzzy subsequence: every query character
 * must appear in order. Matches at the start of a path segment or word, runs of
 * consecutive matches and matches in the file name score higher; long paths a
 * little lower. Undefined when it does not match.
 */
export function fuzzyScore(query: string, path: string): { score: number; indices: number[] } | undefined {
  const needle = query.toLowerCase().replace(/\s+/gu, "");
  if (!needle) return { score: 0, indices: [] };
  const haystack = path.toLowerCase();
  const nameStart = path.lastIndexOf("/") + 1;
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of needle) {
    const index = haystack.indexOf(char, from);
    if (index < 0) return undefined;
    indices.push(index);
    const before = index === 0 ? "/" : path[index - 1]!;
    if (index === previous + 1) score += 5;
    if (/[/_\-. ]/u.test(before)) score += 8;
    else if (before === before.toLowerCase() && path[index] !== path[index]!.toLowerCase()) score += 6;
    if (index >= nameStart) score += 3;
    previous = index;
    from = index + 1;
  }
  if (basename(haystack).startsWith(needle)) score += 20;
  score -= path.length / 10;
  return { score, indices };
}

/** The best matches for `query` among files under `cwd`. */
export async function localFileSearch(query: string, cwd: string, limit = 50): Promise<FileMatch[]> {
  if (!isAbsolute(cwd)) throw new AgentEngineError("searchFiles() needs an absolute cwd.");
  const matches: FileMatch[] = [];
  for (const path of await listFolderFiles(cwd)) {
    const match = fuzzyScore(query, path);
    if (match) matches.push({ path, score: match.score, indices: match.indices });
  }
  return matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

/** Media types by extension, for files given by path. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
  ".json": "application/json", ".html": "text/html", ".htm": "text/html", ".xml": "application/xml", ".yaml": "application/yaml", ".yml": "application/yaml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

/** A file's media type from its extension; `application/octet-stream` when unknown. */
export function mediaTypeOf(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Whether a media type is text a model can read as it is. */
export function isTextMedia(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "application/xml" || mediaType === "application/yaml";
}

/** A file's name, media type and bytes, read from disk for a path. */
export async function readFileInput(file: FileInput): Promise<{ name: string; mediaType: string; data: Buffer; path?: string }> {
  if (file.type === "base64") return { name: file.name, mediaType: file.mediaType, data: Buffer.from(file.data, "base64") };
  if (!isAbsolute(file.path)) throw new AgentEngineError(`An attached file needs an absolute path: ${file.path}`);
  return { name: file.name ?? basename(file.path), mediaType: file.mediaType ?? mediaTypeOf(file.path), data: await readFile(file.path), path: file.path };
}

/** The line that names attached files for a runtime that opens them itself. */
export function attachedFilesNote(paths: string[]): string {
  return paths.length ? `\n\nAttached files:\n${paths.map((path) => `- ${path}`).join("\n")}` : "";
}

/** Folder for files a turn attached as base64, for runtimes that read attachments from disk. */
const ATTACHMENT_DIR = join(tmpdir(), "agent-engines", "attachments");

/** Writes an attachment to a temporary file and returns its path. */
export async function saveAttachment(name: string, data: Buffer): Promise<string> {
  await mkdir(ATTACHMENT_DIR, { recursive: true });
  const path = join(ATTACHMENT_DIR, `${randomUUID()}-${name.replace(/[^A-Za-z0-9._-]/gu, "_")}`);
  await writeFile(path, data);
  return path;
}
