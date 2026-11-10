/**
 * Entry loader for widget packages (D691).
 *
 * Mirrors the trusted-extension loader: jiti, no module cache, no native
 * resolution, so a package written as ESM or CJS loads the same way in a
 * packaged build as in a source checkout. Widget packages get **no** virtual
 * kernel modules — reaching into pi internals is not part of this contract.
 */
export type WidgetEntryFactory = (api: unknown) => unknown | Promise<unknown>;

/** Import an entry module and return its default export when it is a function. */
export async function loadWidgetEntry(entry: string): Promise<WidgetEntryFactory | undefined> {
  // Lazy: Electron main bundles this package for discovery and must never pull
  // jiti into its own bundle.
  const { createJiti } = await import("jiti/static");
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    tryNative: false,
  });
  const loaded = await jiti.import(entry, { default: true });
  return typeof loaded === "function" ? (loaded as WidgetEntryFactory) : undefined;
}
