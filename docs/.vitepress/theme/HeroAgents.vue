<script setup lang="ts">
// Logos of the agents agent-engines can drive, floating to the right of the
// home headline. Each tile bobs on its own loop and leans a little towards the
// pointer, nearer tiles more than farther ones.
import { onBeforeUnmount, onMounted, ref } from "vue";
import claude from "./agents/claude-color.svg?raw";
import codex from "./agents/codex.svg?raw";
import opencode from "./agents/opencode.svg?raw";
import antigravity from "./agents/antigravity-color.svg?raw";

// x and y place the tile in the hero (percent), size is in px, depth scales
// the pointer lean, and float is the bob loop's length in seconds.
const tiles = [
  { name: "Claude", svg: claude, x: 67, y: 10, size: 96, rot: -8, depth: 1, float: 7 },
  { name: "Antigravity", svg: antigravity, x: 88, y: 4, size: 62, rot: 12, depth: 0.5, float: 10 },
  { name: "Codex", svg: codex, x: 84, y: 38, size: 86, rot: 9, depth: 0.8, float: 8.5 },
  { name: "OpenCode", svg: opencode, x: 68, y: 64, size: 72, rot: -11, depth: 0.7, float: 9.2 },
];

const root = ref<HTMLElement | null>(null);
let frame = 0;

function onPointer(event: PointerEvent) {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    const el = root.value;
    if (!el) return;
    // -1 to 1 across the window
    el.style.setProperty("--mx", (event.clientX / window.innerWidth) * 2 - 1 + "");
    el.style.setProperty("--my", (event.clientY / window.innerHeight) * 2 - 1 + "");
  });
}

onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  window.addEventListener("pointermove", onPointer, { passive: true });
});

onBeforeUnmount(() => {
  window.removeEventListener("pointermove", onPointer);
  cancelAnimationFrame(frame);
});
</script>

<template>
  <div ref="root" class="ae-agents" aria-hidden="true">
    <div class="field">
      <div
        v-for="(t, i) in tiles"
        :key="t.name"
        class="lean"
        :style="{
          left: t.x + '%',
          top: t.y + '%',
          '--depth': t.depth,
        }"
      >
        <div
          class="tile"
          :title="t.name"
          :style="{
            '--size': t.size + 'px',
            '--rot': t.rot + 'deg',
            '--float': t.float + 's',
            '--enter': 0.25 + i * 0.09 + 's',
            '--fade': 0.55 + t.depth * 0.45,
          }"
        >
          <span class="logo" v-html="t.svg" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ae-agents {
  --mx: 0;
  --my: 0;
  pointer-events: none;
}

/* Lines the tiles up with the hero's own container. */
.field {
  position: relative;
  max-width: 1152px;
  height: 100%;
  margin: 0 auto;
}

/* Narrow screens: a loose row of small tiles above the headline, which needs the full width. */
.ae-agents {
  /* Above the hero, which is pulled up under the nav bar and would cover the row. */
  position: relative;
  z-index: 1;
  padding: 36px 20px 0;
}

.field {
  display: flex;
  align-items: center;
  gap: 14px;
}

.tile {
  width: calc(var(--size) * 0.56);
}

@media (min-width: 768px) {
  .ae-agents {
    padding: 48px 48px 0;
  }
}

/* Wide screens: the tiles float to the right of the headline, across the hero's height. */
@media (min-width: 1100px) {
  .ae-agents {
    position: absolute;
    top: var(--vp-nav-height, 64px);
    left: 0;
    right: 0;
    height: 470px;
    padding: 0;
  }

  .field {
    display: block;
  }

  .lean {
    position: absolute;
  }

  .tile {
    width: var(--size);
  }
}

.lean {
  translate: calc(var(--mx) * var(--depth) * -14px) calc(var(--my) * var(--depth) * -10px);
  transition: translate 0.6s cubic-bezier(0.2, 0.7, 0.2, 1);
}

.tile {
  display: grid;
  place-items: center;
  aspect-ratio: 1;
  border-radius: 26%;
  background: var(--ae-panel);
  border: 1px solid var(--ae-rule-soft);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.55),
    0 22px 44px -24px rgb(20 19 15 / 0.45),
    0 2px 6px rgb(20 19 15 / 0.06);
  color: var(--ae-ink);
  opacity: var(--fade);
  rotate: var(--rot);
  animation:
    ae-tile-in 0.9s cubic-bezier(0.2, 0.7, 0.2, 1) var(--enter) both,
    ae-tile-float var(--float) ease-in-out calc(var(--enter) + 0.9s) infinite alternate;
}

:global(.dark) .tile {
  box-shadow:
    inset 0 1px 0 rgb(243 240 232 / 0.06),
    0 22px 44px -20px rgb(0 0 0 / 0.8);
}

.logo {
  display: block;
  width: 48%;
  height: 48%;
}

.logo :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

@keyframes ae-tile-in {
  from {
    opacity: 0;
    scale: 0.8;
    translate: 0 16px;
  }
}

@keyframes ae-tile-float {
  /* Starts where the entrance ends, so there is no jump between them. */
  from {
    translate: 0 0;
    rotate: var(--rot);
  }
  to {
    translate: 0 -14px;
    rotate: calc(var(--rot) + 3deg);
  }
}
</style>
