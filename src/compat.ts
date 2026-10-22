/**
 * @file What this library needs from each runtime, and checks of an installed
 * runtime against it. Ported from Blitz's `runtime-compat.ts`.
 *
 * Runtimes update on their own schedule, and drift usually shows up later as a
 * failed turn. `CODEX_PROTOCOL_CONTRACT` lists every Codex method and enum value
 * the engines call or branch on (a test scans `src/` to keep it complete), so
 * `npm run check:runtimes` can report drift directly from a newer CLI's schema.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Explains why `version` is older than `minimum`, or returns undefined when it
 * is recent enough. Compares the first `major.minor.patch` in each string.
 */
export function checkMinimumVersion(version: string, minimum: string): string | undefined {
  const parsed = parseRuntimeVersion(version);
  const floor = parseRuntimeVersion(minimum);
  if (!parsed || !floor) return `${version} is not a recognisable version`;
  return compareVersions(parsed, floor) < 0 ? `${minimum} or newer is required` : undefined;
}

/** Reads the first `major.minor.patch` triple from CLI version output. */
export function parseRuntimeVersion(output: string): readonly [number, number, number] | undefined {
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)\b/u);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Orders two version triples. */
export function compareVersions(left: readonly [number, number, number], right: readonly [number, number, number]): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/**
 * The Codex app-server protocol surface the engine calls or interprets. Enum
 * entries list only the values the engine branches on, so values Codex adds
 * later do not count as drift.
 */
export const CODEX_PROTOCOL_CONTRACT = {
  clientRequests: [
    "initialize",
    "account/read",
    "model/list",
    "thread/start",
    "thread/resume",
    "thread/turns/list",
    "thread/compact/start",
    "thread/delete",
    "thread/list",
    "thread/unsubscribe",
    "mcpServerStatus/list",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
  ],
  clientNotifications: ["initialized"],
  serverNotifications: [
    "turn/started",
    "turn/completed",
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "item/reasoning/textDelta",
    "item/reasoning/summaryTextDelta",
    "error",
    "thread/tokenUsage/updated",
    "account/rateLimits/updated",
    "model/rerouted",
    "serverRequest/resolved",
  ],
  serverRequests: [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
    "item/tool/call",
    "mcpServer/elicitation/request",
    "applyPatchApproval",
    "execCommandApproval",
  ],
  enums: {
    ThreadItem: [
      "agentMessage",
      "reasoning",
      "commandExecution",
      "fileChange",
      "mcpToolCall",
      "dynamicToolCall",
      "collabAgentToolCall",
      "subAgentActivity",
      "webSearch",
      "contextCompaction",
    ],
    TurnStatus: ["completed", "failed", "interrupted", "inProgress"],
    CodexErrorInfo: ["usageLimitExceeded", "rateLimitExceeded", "serverOverloaded", "contextWindowExceeded", "unauthorized"],
    CollabAgentTool: ["spawnAgent"],
    CollabAgentStatus: ["completed", "errored", "shutdown", "interrupted"],
    SubAgentActivityKind: ["started", "completed", "interrupted"],
  },
} as const;

/** Method groups in the Codex protocol, keyed like `CODEX_PROTOCOL_CONTRACT`. */
export type CodexProtocolMethodGroup = Exclude<keyof typeof CODEX_PROTOCOL_CONTRACT, "enums">;

/** Schema files `codex app-server generate-json-schema` writes for each group. */
const CODEX_SCHEMA_FILES: Readonly<Record<CodexProtocolMethodGroup, string>> = {
  clientRequests: "ClientRequest.json",
  clientNotifications: "ClientNotification.json",
  serverNotifications: "ServerNotification.json",
  serverRequests: "ServerRequest.json",
};

/** Methods and shared definitions read from one generated protocol schema. */
export interface CodexProtocolSurface {
  readonly methods: Readonly<Record<CodexProtocolMethodGroup, ReadonlySet<string>>>;
  readonly definitions: Readonly<Record<string, unknown>>;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Collects method names from the `oneOf` variants of one message schema. */
function schemaMethods(schema: unknown): Set<string> {
  const methods = new Set<string>();
  const variants = asObject(schema)?.oneOf;
  if (!Array.isArray(variants)) return methods;
  for (const variant of variants) {
    const method = asObject(asObject(asObject(variant)?.properties)?.method);
    for (const value of Array.isArray(method?.enum) ? method.enum : []) if (typeof value === "string") methods.add(value);
  }
  return methods;
}

/** Reads the protocol surface from the output of `codex app-server generate-json-schema`. */
export async function readCodexProtocolSurface(schemaDirectory: string): Promise<CodexProtocolSurface> {
  const methods = {} as Record<CodexProtocolMethodGroup, ReadonlySet<string>>;
  const definitions: Record<string, unknown> = {};
  for (const [group, file] of Object.entries(CODEX_SCHEMA_FILES) as [CodexProtocolMethodGroup, string][]) {
    const schema: unknown = JSON.parse(await readFile(join(schemaDirectory, file), "utf8"));
    methods[group] = schemaMethods(schema);
    Object.assign(definitions, asObject(asObject(schema)?.definitions) ?? {}, asObject(asObject(schema)?.$defs) ?? {});
  }
  return { methods, definitions };
}

/** Collects every string `enum` or `const` value nested inside a definition. */
function enumValues(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) enumValues(item, output);
    return output;
  }
  const object = asObject(value);
  if (!object) return output;
  if (Array.isArray(object.enum)) for (const item of object.enum) if (typeof item === "string") output.add(item);
  if (typeof object.const === "string") output.add(object.const);
  // A one-key object variant ({ "httpConnectionFailed": {...} }) names its value by its required key.
  if (Array.isArray(object.required) && object.required.length === 1 && typeof object.required[0] === "string") output.add(object.required[0]);
  for (const child of Object.values(object)) enumValues(child, output);
  return output;
}

const METHOD_GROUP_LABELS: Readonly<Record<CodexProtocolMethodGroup, string>> = {
  clientRequests: "client request",
  clientNotifications: "client notification",
  serverNotifications: "server notification",
  serverRequests: "server request",
};

/** Lists contract entries the installed Codex protocol no longer provides; empty when in sync. */
export function codexProtocolProblems(surface: CodexProtocolSurface): string[] {
  const problems: string[] = [];
  for (const group of Object.keys(METHOD_GROUP_LABELS) as CodexProtocolMethodGroup[]) {
    for (const method of CODEX_PROTOCOL_CONTRACT[group]) {
      if (!surface.methods[group].has(method)) problems.push(`Missing ${METHOD_GROUP_LABELS[group]}: ${method}`);
    }
  }
  for (const [name, required] of Object.entries(CODEX_PROTOCOL_CONTRACT.enums)) {
    const definition = surface.definitions[name];
    if (definition === undefined) {
      problems.push(`Missing protocol definition: ${name}`);
      continue;
    }
    const values = enumValues(definition);
    for (const value of required) if (!values.has(value)) problems.push(`${name} no longer includes ${value}`);
  }
  return problems;
}

/** Minimal model shape compared between an app's own model list and a live catalogue. */
export interface ComparableModel {
  readonly id: string;
  readonly efforts?: readonly string[];
}

/** Differences between an expected model list and a live catalogue. */
export interface ModelCatalogDrift {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly { readonly id: string; readonly expected: readonly string[]; readonly live: readonly string[] }[];
}

/** Compares an expected model list with a live catalogue by ID and efforts; labels are ignored. */
export function diffModelCatalog(expected: readonly ComparableModel[], live: readonly ComparableModel[]): ModelCatalogDrift {
  const expectedById = new Map(expected.map((model) => [model.id, model]));
  const liveIds = new Set(live.map((model) => model.id));
  const changed: ModelCatalogDrift["changed"][number][] = [];
  for (const model of live) {
    const known = expectedById.get(model.id);
    if (!known) continue;
    const before = known.efforts ?? [];
    const after = model.efforts ?? [];
    if (before.join() !== after.join()) changed.push({ id: model.id, expected: before, live: after });
  }
  return {
    added: live.filter((model) => !expectedById.has(model.id)).map((model) => model.id),
    removed: expected.filter((model) => !liveIds.has(model.id)).map((model) => model.id),
    changed,
  };
}

/** Whether a catalogue comparison found any drift. */
export function hasModelCatalogDrift(drift: ModelCatalogDrift): boolean {
  return drift.added.length > 0 || drift.removed.length > 0 || drift.changed.length > 0;
}
