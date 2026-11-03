# Capabilities

`await engine.capabilities()` describes what the runtime can do, so a UI shows only the controls that work. When a feature is `false`, its method throws `UnsupportedFeatureError`, except that ACP's `steer` throws `SteerRejectedError`. A conformance test runs each feature with a method against every engine.

ACP's answers depend on the agent, because they come from its `initialize` reply.

| | Codex | Claude | ACP |
| --- | --- | --- | --- |
| Steer, compact | Yes | Yes | No |
| Fork | Yes, through any turn | Yes, through any turn | Whole session, if the agent offers it |
| Rewind | Conversation and files | Conversation, and files with `fileCheckpoints` | No |
| List and read threads | Yes | Yes | If the agent can list and load sessions |
| Rename, archive | Both | Rename only | No |
| Plan mode | Yes | Yes | If the agent has a plan mode |
| Structured output | Yes | Yes | No |
| Files | Named by path | PDFs and text as documents | Embedded, or linked |
| Goals | Yes | No | No |
| Review | Native | A review prompt | A review prompt |
| Shell | Yes | No | No |
| Background tasks | Yes | Yes | No |
| Live MCP changes | Reload, sign-in, resources | Replace, restart, toggle, resources | No |
| Sign-in from the app | Yes | No | No |
| Turn limits | No | Yes | No |
| Fast mode | Yes | Yes, on models that offer it | No |
| Realtime voice | Yes | No | No |

For how Codex restores files on a rewind, see [How files come back](/guide/threads#how-files-come-back). The full set of flags is the `Capabilities` type.
