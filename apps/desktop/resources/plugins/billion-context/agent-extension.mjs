/**
 * Bundled billion-context extension.
 *
 * The upstream package publishes its pi extension at `dist/agent/billion-context.js`
 * (`pi.extensions` in its package.json); this module only re-exports it so the
 * plugin's `contributes.agentExtensions` has a stable local entry. The vendored
 * files are byte-identical to the published package — see SOURCES.md.
 */
export { default } from "./vendor/pi/billion-context.js";
