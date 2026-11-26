import type { Theme } from "vitepress";
import { h } from "vue";
// The same theme as "vitepress/theme", without its Inter stylesheet, which
// would otherwise fetch a font from a CDN that this site never shows.
import DefaultTheme from "vitepress/theme-without-fonts";
import "@fontsource-variable/instrument-sans";
// Archivo with its width axis, for the expanded display headlines.
import "@fontsource-variable/archivo/wdth.css";
import "./custom.css";
import HeroAgents from "./HeroAgents.vue";
import HomeHighlights from "./HomeHighlights.vue";

const theme: Theme = {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "home-hero-before": () => h(HeroAgents),
      "home-features-before": () => h(HomeHighlights),
    }),
};

export default theme;
