# Development

```sh
git clone https://github.com/agmada-asa/agent-engines
cd agent-engines && npm install
npm test            # unit tests with fake transports
npm run typecheck
```

## Live tests

These run real turns on cheap models, in a temporary folder, and use your sign-ins:

```sh
AGENT_ENGINES_LIVE=1 npm run test:live
```

- **Codex and Claude:** a steered turn, an interrupted turn, a compaction, a resume and a delete. A second scenario checks plan mode, structured output, history, rename, fork, rewind, a handoff seed and a review.
- **Codex only:** a tier catalogue, a thread acknowledgment and a turn whose requested tier stays separate from that acknowledgment. Uses `priority` when the selected model lists it, otherwise the runtime default; does not require Ultrafast access.
- **Claude only:** a question round trip, and confirming a subagent's real model from its own messages.
- **ACP:** a turn with a tool and an edit, plan mode, a resume with history, a fork and a handoff, on OpenCode. It skips when `opencode` isn't installed.

Override the models with `AGENT_ENGINES_CLAUDE_MODEL`, `AGENT_ENGINES_CODEX_MODEL` and `AGENT_ENGINES_ACP_MODEL`.

The Antigravity questions test also needs `AGENT_ENGINES_ANTIGRAVITY_COMMAND`, the path to a signed-in `agy_acp_server.par`, and skips without it. It adds one session to Antigravity's history on each run, and its model decides when to call its tools, so a failure can mean the model didn't ask.

## Documentation

The docs site is built with [VitePress](https://vitepress.dev) from the `docs` folder, which has its own dependencies. A push to `main` that changes it deploys to GitHub Pages.

```sh
cd docs && npm ci
npm run dev
```

## Licence

[MIT](https://github.com/agmada-asa/agent-engines/blob/main/LICENSE)
