<script setup lang="ts">
// The home page's feature cards, from `highlights` in index.md's frontmatter.
import { useData, withBase } from "vitepress";
import {
  Activity,
  ArrowLeftRight,
  ArrowUpRight,
  ListChecks,
  MessagesSquare,
  RefreshCw,
  ShieldCheck,
} from "lucide-vue-next";

interface Highlight {
  icon: string;
  title: string;
  details: string;
  link?: string;
}

const icons = {
  activity: Activity,
  "arrow-left-right": ArrowLeftRight,
  "list-checks": ListChecks,
  "messages-square": MessagesSquare,
  "refresh-cw": RefreshCw,
  "shield-check": ShieldCheck,
};

const { frontmatter } = useData();
const highlights = (frontmatter.value.highlights ?? []) as Highlight[];
</script>

<template>
  <section v-if="highlights.length" class="ae-highlights">
    <div class="container">
      <h2 class="heading">What you get</h2>
      <div class="grid">
        <component
          :is="h.link ? 'a' : 'div'"
          v-for="h in highlights"
          :key="h.title"
          class="card"
          :href="h.link ? withBase(h.link) : undefined"
        >
          <span class="icon">
            <component :is="icons[h.icon as keyof typeof icons]" :size="20" :stroke-width="1.75" />
          </span>
          <h3 class="title">{{ h.title }}</h3>
          <p class="details">{{ h.details }}</p>
          <ArrowUpRight v-if="h.link" class="go" :size="18" :stroke-width="1.75" aria-hidden="true" />
        </component>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Side padding follows the hero's, so the cards line up with the headline. */
.ae-highlights {
  padding: 8px 20px 96px;
}

@media (min-width: 768px) {
  .ae-highlights {
    padding: 16px 48px 112px;
  }
}

@media (min-width: 960px) {
  .ae-highlights {
    padding: 24px 64px 128px;
  }
}

.container {
  max-width: 1152px;
  margin: 0 auto;
}

.heading {
  margin: 0 0 28px;
  padding-top: 40px;
  border-top: 1px solid var(--ae-rule-soft);
  font-family: var(--ae-font-display);
  font-stretch: 125%;
  font-size: clamp(24px, 3vw, 34px);
  font-weight: 640;
  line-height: 1.1;
  letter-spacing: -0.045em;
  color: var(--ae-ink);
}

.grid {
  display: grid;
  gap: 14px;
}

@media (min-width: 640px) {
  .grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (min-width: 960px) {
  .grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

.card {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 26px 26px 28px;
  border: 1px solid var(--ae-rule-soft);
  border-radius: 22px;
  background: var(--ae-panel);
  color: inherit;
  text-decoration: none;
  transition:
    border-color 0.25s,
    translate 0.25s cubic-bezier(0.2, 0.7, 0.2, 1),
    box-shadow 0.25s;
}

a.card:hover {
  border-color: var(--ae-rule);
  translate: 0 -2px;
  box-shadow: 0 18px 36px -24px rgb(20 19 15 / 0.35);
}

:global(.dark) a.card:hover {
  box-shadow: 0 18px 36px -20px rgb(0 0 0 / 0.7);
}

.icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: var(--ae-blue-tint);
  color: var(--ae-blue-deep);
}

.title {
  margin: 22px 0 0;
  padding: 0;
  border: 0;
  font-size: 19px;
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.025em;
  color: var(--ae-ink);
}

.details {
  margin: 8px 0 0;
  font-size: 15px;
  line-height: 1.65;
  color: var(--ae-ink-muted);
}

.go {
  position: absolute;
  top: 26px;
  right: 24px;
  color: var(--ae-ink-subtle);
  opacity: 0;
  translate: -4px 4px;
  transition:
    opacity 0.25s,
    translate 0.25s cubic-bezier(0.2, 0.7, 0.2, 1);
}

a.card:hover .go,
a.card:focus-visible .go {
  opacity: 1;
  translate: 0 0;
}
</style>
