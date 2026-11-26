/**
 * The surface rail's geometry.
 *
 * The rail is one more flex column inside `.app-shell`, so the width the chat
 * budgets may spend (sidebar, main pane, work panel) is the window's width minus
 * this figure. Keeping it a constant next to the rail — rather than in a CSS
 * variable read back from the DOM — means the two branches that compute those
 * budgets cannot drift from what is actually drawn.
 */
export const SURFACE_RAIL_WIDTH = 48;
