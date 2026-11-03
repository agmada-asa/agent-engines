# Models, effort and speed

## Choosing a model

`engine.models()` returns what the runtime offers. Each entry has an `id`, `label`, `efforts` and `fastMode`, and can have `defaultEffort`, `isDefault`, `hidden` and `inputModalities`. Codex also returns `serviceTiers`, with each tier's `id`, `name` and `description` from the signed-in account's catalogue.

The list depends on the sign-in and the runtime version, so read it at runtime rather than hard-coding IDs.

Set `model`, `effort` and `fastMode` on the thread or on any turn. A turn's choice sticks for later turns:

```ts
const thread = await engine.startThread({ cwd, model: "gpt-6-luna", effort: "low" });
await thread.run("A harder question", { model: "gpt-6.1-sol", effort: "high" }).result;
```

## Knowing which model answered

Runtimes can move a request to a different model, so there are three checks:

- `strictModel` fails a silent model swap. It's on unless you set it to `false`.
- A `model.rerouted` event reports a change of model.
- A `model.confirmed` event (Claude only) gives the model that actually answered, read from the agent's own messages, with `agentId` set for a subagent.

`subagent.started` has no `model` from Claude, because the SDK doesn't report one when a subagent starts. Codex's `model` there is what the runtime reports at the start, not a confirmation from the subagent's messages.

## Effort

`effort` is a string, and the levels vary by model, so check the model's `efforts`.

On ACP agents it sets the session's `thought_level` option, and a level the agent doesn't offer throws an error.

### Codex's `ultra` effort

Models that list `ultra` in `efforts` accept `effort: "ultra"`, which Codex's protocol describes as proactive multi-agent behaviour:

```ts
await thread.run("Migrate the test suite", { effort: "ultra" }).result;
```

## Speed

`fastMode: true` asks for the runtime's faster option on models whose catalogue entry has `fastMode: true`.

| Runtime | What `fastMode` does |
| --- | --- |
| Codex | Requests the `priority` service tier, which the Codex catalogue labels "Fast" |
| Claude | Turns on Claude's fast mode |
| ACP | Nothing; the option is ignored, and every ACP model reports `fastMode: false` |

The speed gain and any extra usage vary by model. Codex describes them in its own catalogue.

### Codex's Ultrafast tier

Use `serviceTier` to select a Codex tier explicitly, including `ultrafast`:

```ts
const models = await engine.models();
const tiers = models.find((model) => model.id === "gpt-6.1-sol")?.serviceTiers ?? [];

if (tiers.some((tier) => tier.id === "ultrafast")) {
  const thread = await engine.startThread({ cwd, model: "gpt-6.1-sol", serviceTier: "ultrafast" });
  console.log(thread.serviceTier); // { requested, accepted, mismatch }
  const result = await thread.run("Review the changes").result;
  console.log(result.serviceTier); // { requested: "ultrafast" }, not inference confirmation
}
```

`serviceTier` takes a catalogue ID, or `null` to reset to the runtime's default. It works on start, resume, fork and per turn, and a turn's choice sticks for later turns and reconnection. An explicit `serviceTier` overrides `fastMode` in the same call. A later `fastMode: true` selects `priority`; `false` resets the tier. Claude and ACP reject `serviceTier`; use Claude's `fastMode` instead.

### Requested and accepted tiers

`thread.serviceTier` exposes the requested tier and the tier Codex acknowledged in its start, resume or fork response. `accepted: null` means the runtime's default; a missing `accepted` means it did not report one. When an explicit request differs from the acknowledgment, `mismatch` is `true` and the thread emits a warning notice. Read the property after opening a thread, since an initial event happens before you can subscribe. Changing the tier or model on a turn, or losing the connection, clears the old acknowledgment.

`service-tier.updated` events have `scope: "thread"` for those acknowledgments and `scope: "turn"` for turn requests. A thread event has an empty `turnId`. The current Codex protocol does not confirm the inference tier used for a turn, so `result.serviceTier` and turn-scoped events report the request and leave `accepted` absent. A thread acknowledgment is a setting, not proof of inference service or billing. The engine passes tier IDs through to Codex; its live catalogue helps a UI offer available choices, but the runtime decides whether to accept a request.

OpenAI [documents Ultrafast](https://learn.chatgpt.com/codex/speed) for GPT-6 Astra and GPT-6.1 Sol in Codex on Pro $500 and eligible Enterprise and Edu plans, as well as through the API. Availability depends on the account and plan; a catalogue without Ultrafast doesn't establish whether other accounts have access.
