# Sign-in and billing

agent-engines uses the sign-ins from `codex login` and `claude`.

## Subscription by default

By default it refuses to run on an API key, so turns are never billed per token by accident. It removes API-key variables from the runtime's environment, and `availability()` reports `reason: "api-key"` if the runtime is signed in with one.

To allow API keys, set `requireSubscription: false` on the engine:

```ts
const engine = createEngine("codex", { requireSubscription: false });
```

## Building for other people

agent-engines has no Claude login of its own. It uses the sign-in the person already made with Claude Code on their machine. Before you ship a product to others, check each provider's terms.

Anthropic's [Agent SDK documentation](https://code.claude.com/docs/en/agent-sdk/overview) says (checked November 2026):

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK.

The same page points those developers to API keys. Its [plan article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) also says third-party app usage draws from subscription limits. Neither page says where a local app that drives a person's own Claude Code sign-in stands, so ask Anthropic if your product depends on it.

If your product handles the login itself, or runs agents for people on your servers, use an API key. With agent-engines, that means `requireSubscription: false`.

The terms are the provider's and can change. This page is not legal advice.

## Signing in from your app

`engine.login({ method: "browser" | "device-code" })` (Codex only) returns a URL, plus a code for device sign-in. Its `done` promise settles when sign-in finishes.

## Running two accounts

Give each engine its own home to run two accounts side by side, each with its own `usage()`:

- Codex: `CodexEngineOptions.home` (`CODEX_HOME`)
- Claude: `ClaudeEngineOptions.configDir` (`CLAUDE_CONFIG_DIR`)

## Reading plan limits

`engine.usage()` reads the signed-in plan's windows without a model call, using Codex's `account/rateLimits/read` and the data behind Claude's `/usage`.

Each window has a `kind` (`session`, `weekly`, `monthly`), `usedPercent` and `resetsAt`, plus `model` when it limits one model family. An account with no plan limits reports `available: false`.
