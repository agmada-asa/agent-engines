/**
 * @file Code review for runtimes without a review command of their own: the
 * prompt that asks for one, so `Thread.review` works the same everywhere.
 */

import type { ReviewTarget } from "./types.ts";

/** The prompt a runtime without its own review command gets for a review. */
export function reviewPrompt(target: ReviewTarget): string {
  const scope =
    target.type === "uncommitted" ? "the uncommitted changes in this repository: staged, unstaged and untracked files (`git status`, `git diff HEAD`)"
    : target.type === "base-branch" ? `the changes on this branch against ${target.branch} (\`git diff ${target.branch}...HEAD\`)`
    : target.type === "commit" ? `commit ${target.sha}${target.title ? ` (${target.title})` : ""} (\`git show ${target.sha}\`)`
    : "the code described below";
  return [
    `Review ${scope}.`,
    ...(target.type === "custom" ? ["", target.instructions] : []),
    "",
    "Look for bugs, security problems, broken edge cases and missing tests. For each finding give the file and line, what goes wrong and how to fix it, most serious first. Say plainly if you find nothing worth fixing. Do not change any files.",
  ].join("\n");
}
