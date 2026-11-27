/**
 * The host palette, applied to the AutoTest workbench's page.
 *
 * The workbench is a Vue application with its own design system. Its colours are
 * semantic variables in `services/autotest/ui/src/style.css` — `--surface`,
 * `--surface-2`, `--fg`, `--line`, `--accent-*` — switched by one `dark` class on
 * `<html>`. That is the seam this module uses: the surface does not restyle the
 * page, it hands it the same palette the rest of the window uses, so the second
 * interface looks like part of the product instead of an embedded web app.
 *
 * Two things are deliberately *not* touched:
 *
 * - the semantic status colours (`--danger`, `--success`, `--warn`): a failing
 *   test must stay red in both interfaces;
 * - the page's layout and components. Overriding variables cannot break markup.
 *
 * The injected values mirror `apps/desktop/src/styles/tokens.css` (neutral gray
 * ramp, white as the accent). They are duplicated rather than read from the
 * renderer because this page lives in another process — and
 * `apps/desktop/test/autotest-surface-theme.test.mjs` fails if the variable names
 * it sets ever stop existing on the other side.
 */

export type WorkbenchTheme = "light" | "dark";

export function isWorkbenchTheme(value: unknown): value is WorkbenchTheme {
  return value === "light" || value === "dark";
}

/**
 * Dark palette, scoped to the workbench's own `dark` class.
 *
 * Elevation follows the shell: the page sits on `--surface-2` (#181818, the
 * window's primary background) and cards/headers on `--surface` (#212121, the
 * raised background). Text and hairlines use the same white-alpha steps the
 * tokens define, so a card edge here reads exactly like a card edge in chat.
 */
const DARK_PALETTE = `
  --surface: #212121;
  --surface-2: #181818;
  --surface-3: #282828;
  --surface-4: #303030;
  --fg: #ffffff;
  --fg-2: rgba(255, 255, 255, 0.8);
  --fg-3: rgba(255, 255, 255, 0.7);
  --muted: rgba(255, 255, 255, 0.52);
  --muted-2: rgba(255, 255, 255, 0.38);
  --line: rgba(255, 255, 255, 0.08);
  --line-soft: rgba(255, 255, 255, 0.05);
  --line-strong: rgba(255, 255, 255, 0.14);
  --accent: #ffffff;
  --accent-solid: #303030;
  --accent-soft: #282828;
  --accent-line: rgba(255, 255, 255, 0.14);
`;

/**
 * Light palette, scoped the same way.
 *
 * The workbench's own light theme is already white-on-neutral, so this only
 * neutralises the hue: the same gray ramp the shell uses in light mode, so a
 * light window and its AutoTest surface do not differ by a blue cast.
 */
const LIGHT_PALETTE = `
  --surface: #ffffff;
  --surface-2: #f5f5f5;
  --surface-3: #ededed;
  --surface-4: #e2e2e2;
  --fg: #141414;
  --fg-2: rgba(0, 0, 0, 0.78);
  --fg-3: rgba(0, 0, 0, 0.66);
  --muted: rgba(0, 0, 0, 0.52);
  --muted-2: rgba(0, 0, 0, 0.38);
  --line: rgba(0, 0, 0, 0.1);
  --line-soft: rgba(0, 0, 0, 0.06);
  --line-strong: rgba(0, 0, 0, 0.16);
  --accent: #141414;
  --accent-solid: #242424;
  --accent-soft: #ededed;
  --accent-line: rgba(0, 0, 0, 0.16);
`;

export const WORKBENCH_THEME_CSS = `
/* Injected by the desktop shell for the AutoTest surface. */:root.dark {${DARK_PALETTE}}
:root:not(.dark) {${LIGHT_PALETTE}}
/* The pane already owns the window frame: no second page margin, and the page
   fills the rect it was given instead of reserving a viewport height. */
:root { --pi-surface-fill: 1; }
body { overflow: hidden; }

/* One window chrome, not two.
 *
 * The page was written as a standalone app: it draws its own title bar (project
 * name, theme switch, user chip) and its own left navigation. Embedded in this
 * window those duplicate the host's title bar and eat a second navigation
 * column, and the host's title bar is the one that carries the window buttons
 * and the status bar. So the page keeps only its content: the host draws the
 * top band and the menu, and drives the router in here.
 */
header.h-12,
header.h-14,
aside.w-60 {
  display: none !important;
}

/* The window has one theme control and it is the client's: the page's own switch
   sat in its bottom-right corner, next to a status bar the client already draws. */
[aria-label="主题"] {
  display: none !important;
}

/* The page's environment strip (h-7 + bg-surface-3) repeated facts the window
   shows in its own status bar, and being inside the page it pushed the content up
   by its own height. The shell draws that band for the whole window. */
.h-7.bg-surface-3 {
  display: none !important;
}
`;

/**
 * Toggle the theme on the page.
 *
 * Runs as an expression rather than a script tag so it can be re-applied on every
 * show: the page may have been loaded by a previous session with the other
 * theme, and `insertCSS` alone cannot flip a class.
 */
export function workbenchThemeScript(theme: WorkbenchTheme): string {
  return `(() => {
  const root = document.documentElement;
  root.classList.toggle("dark", ${theme === "dark"});
  root.dataset.piSurfaceTheme = ${JSON.stringify(theme)};
  return true;
})()`;
}
