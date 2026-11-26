---
layout: home
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
