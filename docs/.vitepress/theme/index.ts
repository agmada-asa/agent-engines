import type { Theme } from "vitepress";
// The same theme as "vitepress/theme", without its Inter stylesheet, which
// would otherwise fetch a font from a CDN that this site never shows.
import DefaultTheme from "vitepress/theme-without-fonts";
import "@fontsource-variable/instrument-sans";
import "@fontsource/bbh-bartle/400.css";
import "./custom.css";

const theme: Theme = {
  extends: DefaultTheme,
};

export default theme;
