---
layout: home
head:
  - - meta
    - { property: "og:type", content: "website" }
  - - meta
    - { property: "og:url", content: "https://agmada-asa.github.io/agent-engines/" }
  - - meta
    - { property: "og:title", content: "agent-engines · One API for coding agents" }
  - - meta
    - { property: "og:description", content: "Run Codex, Claude and any ACP agent from one TypeScript API." }
  - - meta
    - { property: "og:image", content: "https://agmada-asa.github.io/agent-engines/og.png" }
  - - meta
    - { property: "og:image:type", content: "image/png" }
  - - meta
    - { property: "og:image:width", content: "1200" }
  - - meta
    - { property: "og:image:height", content: "630" }
  - - meta
    - { property: "og:image:alt", content: "agent-engines: One API for coding agents, with logos for Claude, Antigravity, Codex and OpenCode." }
  - - meta
    - { name: "twitter:card", content: "summary_large_image" }
hero:
  text: One API for coding agents
  tagline: Run Codex, Claude and any ACP agent from your TypeScript app, through the same threads, turns and events.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
# Shown by HomeHighlights.vue. Icons are Lucide names.
highlights:
  - icon: messages-square
    title: Threads and turns
    details: Start, resume, fork and rewind conversations. Steer or interrupt a turn while it runs.
    link: /guide/threads
  - icon: activity
    title: One event stream
    details: Text, reasoning, tool calls, file diffs, plans, subagents and usage arrive in the same shape from every runtime.
    link: /guide/events
  - icon: shield-check
    title: Approvals as events
    details: Permission requests and questions from the agent reach your code, so your app decides what to do with them.
    link: /guide/events#requests
  - icon: arrow-left-right
    title: Portable conversations
    details: Export a conversation from one runtime and continue it on another.
    link: /guide/threads
  - icon: refresh-cw
    title: Runtime management
    details: Check versions, update the CLIs and read plan limits without spending a turn.
    link: /runtimes/updates
  - icon: list-checks
    title: Honest about differences
    details: capabilities() says what a runtime can do. A method it can't run throws an error rather than quietly doing something else.
    link: /runtimes/capabilities
---
