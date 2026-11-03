import { defineConfig } from "vitepress";

export default defineConfig({
  title: "agent-engines",
  description: "One TypeScript API for Codex, Claude and any agent that speaks ACP.",
  base: "/agent-engines/",
  cleanUrls: true,
  lastUpdated: true,
  // The site is light only, so the dark mode toggle is removed.
  appearance: false,
  head: [["meta", { name: "theme-color", content: "#f3f0e8" }]],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Runtimes", link: "/runtimes/capabilities" },
      { text: "Reference", link: "/reference/api" },
      { text: "npm", link: "https://www.npmjs.com/package/agent-engines" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "Sign-in and billing", link: "/guide/sign-in" },
          { text: "Models, effort and speed", link: "/guide/models" },
          { text: "Threads and history", link: "/guide/threads" },
          { text: "Events", link: "/guide/events" },
          { text: "Agent features", link: "/guide/agent-features" },
          { text: "Processes and failures", link: "/guide/processes" },
        ],
      },
      {
        text: "Runtimes",
        items: [
          { text: "Capabilities", link: "/runtimes/capabilities" },
          { text: "ACP agents", link: "/runtimes/acp" },
          { text: "Versions and updates", link: "/runtimes/updates" },
          { text: "Compatibility checks", link: "/runtimes/compatibility" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Public API", link: "/reference/api" },
          { text: "Thread options", link: "/reference/thread-options" },
        ],
      },
      {
        text: "Project",
        items: [{ text: "Development", link: "/development" }],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/agmada-asa/agent-engines" }],
    search: { provider: "local" },
    editLink: {
      pattern: "https://github.com/agmada-asa/agent-engines/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Released under the MIT Licence. Not affiliated with OpenAI, Anthropic or the ACP project.",
    },
  },
});
