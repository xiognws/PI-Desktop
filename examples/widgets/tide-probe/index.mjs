/**
 * Example widget package (D691).
 *
 * Copy this folder into `<userData>/widgets/`, accept its digest on the
 * Widgets page, then invoke `now` from the agent's `Widget` tool
 * (`remember` needs the `host` permission, which is requested here on purpose).
 *
 * The entry module is loaded with jiti and must **default-export a function**:
 * that function is the package's activate hook and receives the api object.
 * Plain CommonJS `module.exports = {...}` is not enough — the loader looks at
 * only a default-exported function activates.
 */
export default async function activate(api) {
  api.log("tide-probe activated");

  api.action("now", async () => ({ now: new Date().toISOString() }));

  api.action("remember", async ({ args, call }) => {
    // "host" is what lets an action reach the host at all; without it the call
    // rejects and the action fails loudly instead of pretending.
    const listed = await call("memory.list", { limit: 50 });
    const memories = Array.isArray(listed?.memories) ? listed.memories : [];
    const note = args && typeof args === "object" ? args.note : undefined;
    return {
      requested: typeof note === "string" && note.length > 0,
      total: typeof listed?.total === "number" ? listed.total : memories.length,
      titles: memories.slice(0, 3).map((entry) => entry?.title ?? ""),
    };
  });
}
