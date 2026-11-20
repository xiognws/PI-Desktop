import assert from "node:assert/strict";
import test from "node:test";

const { BrowserHost } = await import("../main/browser-host.ts");

/*
 * Guest pages are renderer processes.
 *
 * The page map is keyed by `(session, tab)` and nothing used to say how many
 * could be live at once, so a user who previewed files across sessions kept one
 * renderer per tab for the whole run. The bound must show up where it matters —
 * how many panes are alive — while the tabs themselves survive, because a tab
 * that disappears from the panel reads as data loss.
 */

/** Poll a fire-and-forget path instead of guessing at a delay. */
async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met in time");
}

function harness() {
  const panes = [];
  const createPane = (onState) => {
    const pane = {
      index: panes.length + 1,
      disposed: false,
      visible: false,
      navigated: [],
      setWindow() {},
      setVisible(value) {
        pane.visible = value;
      },
      setBounds() {},
      // A pane that reports no web contents is the shape every teardown path
      // already handles (`getWebContents() ?? undefined`).
      getWebContents() {
        return null;
      },
      getState() {
        return null;
      },
      async navigateAndWait(url) {
        pane.navigated.push(url);
        const state = {
          url,
          title: `title:${url}`,
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
        };
        onState?.(state);
        return state;
      },
      action() {},
      async withStableViewport(run) {
        return run(pane.getWebContents());
      },
      openExternal() {},
      dispose() {
        pane.disposed = true;
      },
    };
    panes.push(pane);
    return pane;
  };

  const host = new BrowserHost({
    createPane,
    isPluginLoaded: () => true,
    getFileRoots: async () => [],
    onState: () => {},
    onPresentationState: () => {},
    onRevealView: () => {},
  });

  const alive = () => panes.filter((pane) => !pane.disposed);
  return { host, panes, alive };
}

test("keeps at most four live guest pages across tabs", async () => {
  const { host, alive } = harness();
  const session = "session-a";
  const tabs = [];
  for (let index = 0; index < 6; index += 1) {
    const { tabId } = await host.openTab({ url: `https://example.test/${index}` }, session);
    tabs.push(tabId);
  }
  assert.equal(alive().length, 4, "six tabs must not keep six renderer processes");
  assert.equal(host.getPages(session).length, 6, "every tab still has to be listed");
});

test("evicts the least recently used tab, never the one on screen or connected", async () => {
  const { host, panes, alive } = harness();
  const session = "session-b";
  await host.openTab({ url: "https://example.test/first" }, session);
  await host.openTab({ url: "https://example.test/second" }, session);
  const third = await host.openTab({ url: "https://example.test/third" }, session);
  await host.openTab({ url: "https://example.test/fourth" }, session);

  // The fourth tab is the session's connected tab and the third is on screen.
  host.setChromeSession(session, third.tabId);
  await host.openTab({ url: "https://example.test/fifth" }, session);

  assert.equal(panes[0].disposed, true, "the oldest tab gave up its guest");
  const liveUrls = alive().flatMap((pane) => pane.navigated);
  assert.ok(liveUrls.includes("https://example.test/third"), "the visible tab keeps its guest");
  assert.ok(liveUrls.includes("https://example.test/fourth"), "the connected tab keeps its guest");
  assert.ok(liveUrls.includes("https://example.test/fifth"), "the new tab gets a guest");
});

test("switching back to an evicted tab re-creates its guest at the same location", async () => {
  const { host, panes } = harness();
  const session = "session-c";
  const { tabId } = await host.openTab({ url: "https://example.test/keep-me" }, session);
  for (let index = 0; index < 5; index += 1) {
    await host.openTab({ url: `https://example.test/filler-${index}` }, session);
  }
  assert.equal(panes[0].disposed, true, "the first tab's guest was evicted");

  host.setChromeSession(session, tabId);
  const restored = panes.at(-1);
  assert.equal(restored.disposed, false);
  // The restore navigation is fire-and-forget; wait for it to reach the pane.
  await waitFor(() => restored.navigated.length > 0);
  assert.deepEqual(restored.navigated, ["https://example.test/keep-me"]);
});

test("closing a tab also drops its suspended entry", async () => {
  const { host } = harness();
  const session = "session-d";
  const { tabId } = await host.openTab({ url: "https://example.test/closable" }, session);
  for (let index = 0; index < 5; index += 1) {
    await host.openTab({ url: `https://example.test/filler-${index}` }, session);
  }
  assert.equal(host.getPages(session).length, 6);

  host.closeTab(session, tabId);
  const remaining = host.getPages(session);
  assert.equal(remaining.length, 5);
  assert.ok(remaining.every((page) => page.url !== "https://example.test/closable"));
});

test("does not evict when every live page is on screen or connected", async () => {
  const { host, alive } = harness();
  // Different sessions, each with its own connected tab: no page is a candidate.
  const sessions = ["s1", "s2", "s3", "s4", "s5"];
  for (const session of sessions) {
    await host.openTab({ url: `https://example.test/${session}` }, session);
  }
  assert.equal(alive().length, 5, "the bound yields rather than dropping a page in use");
  assert.equal(host.getPages("s5").length, 1);
});
