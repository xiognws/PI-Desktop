/** Main-window extension: reads identity attributes only, never transcript/draft text.
 * PI-Desktop 0.17's DOM markers are not a stable SDK contract. Fail closed when
 * they are absent/ambiguous instead of guessing from timestamps or running turns.
 */
const PANE = '[data-session-pane][data-visible="true"]';
const ROW = '.thread-item.active[data-sidebar-session-row]';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function identity(nodes, attribute) {
  const ids = new Set([...nodes].map(node => node.getAttribute(attribute)));
  if (ids.size !== 1) return { status: "ambiguous", sessionId: "" };
  const [sessionId] = ids;
  if (!ID.test(sessionId || "") || sessionId.includes("..")) {
    return { status: "unavailable", sessionId: "" };
  }
  return { status: "active", sessionId };
}

export function readContext(doc = document) {
  const panes = doc.querySelectorAll(PANE);
  if (panes.length) return identity(panes, "data-session-pane");
  const rows = doc.querySelectorAll(ROW);
  if (rows.length) return identity(rows, "data-sidebar-session-row");
  // A recognizable shell with no selected conversation is distinct from an
  // unsupported shell. Neither case may retain some other conversation's usage.
  const shell = doc.querySelector('.session-panes, [data-testid="home-empty"], .sidebar');
  return { status: shell ? "none" : "unavailable", sessionId: "" };
}

let dispose = null;
export function onLoad(pi) {
  onUnload();
  const instance = crypto.randomUUID();
  let stopped = false;
  let checkQueued = false;
  let inFlight = false;
  let timer = null;
  let sequence = 0;
  let desired = null;
  let sentKey = "";
  let attempts = 0;
  let nextSendAt = 0;

  const schedule = (delay = 0) => {
    if (stopped || timer !== null) return;
    timer = setTimeout(() => { timer = null; void send(); }, delay);
  };
  const send = async () => {
    if (stopped || inFlight || !desired || desired.key === sentKey || attempts >= 4) return;
    const wait = nextSendAt - Date.now();
    if (wait > 0) { schedule(wait); return; }
    const target = desired;
    inFlight = true;
    attempts += 1;
    nextSendAt = Date.now() + 150; // below the host's ten calls/second ceiling
    sentKey = ""; // a lost acknowledgement may still have changed the backend
    try {
      const result = await pi.dispatch("plugin.call", {
        method: "usage.setContext",
        args: { instance, sequence: target.sequence, ...target.context },
      });
      if (result?.accepted === false) throw new Error("context superseded");
      if (!stopped) { sentKey = target.key; if (desired === target) attempts = 0; }
    } catch {
      // Retry at most three times; a subsequent identity change/focus gets a new budget.
      if (!stopped && desired === target && attempts < 4) schedule(300 * attempts);
    } finally {
      inFlight = false;
      if (!stopped && desired !== target) schedule(Math.max(0, nextSendAt - Date.now()));
    }
  };
  const check = (retry = false) => {
    if (stopped) return;
    const context = readContext();
    const key = `${context.status}:${context.sessionId}`;
    if (desired?.key !== key) {
      desired = { context, key, sequence: ++sequence };
      attempts = 0;
      // Cancel a retry for an identity that is no longer visible.
      if (timer !== null) { clearTimeout(timer); timer = null; }
      schedule();
    } else if (retry && key !== sentKey) {
      attempts = 0;
      schedule();
    }
  };
  const queueCheck = () => {
    if (stopped || checkQueued) return;
    checkQueued = true;
    queueMicrotask(() => { checkQueued = false; check(); });
  };
  const observer = new MutationObserver(records => {
    // Attribute changes are identity/visibility only. Child changes matter
    // only when they add/remove shell/pane/row nodes, not during text streaming.
    if (records.some(record => (record.type === "attributes" &&
        record.target.matches?.('[data-session-pane], [data-sidebar-session-row], .session-panes, .sidebar, [data-testid="home-empty"]')) ||
      [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 &&
        (node.matches?.('[data-session-pane], [data-sidebar-session-row], .session-panes, .sidebar, [data-testid="home-empty"]') ||
         node.querySelector?.('[data-session-pane], [data-sidebar-session-row], .session-panes, .sidebar, [data-testid="home-empty"]'))))) {
      queueCheck();
    }
  });
  observer.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["data-session-pane", "data-visible", "data-sidebar-session-row", "class", "aria-hidden"],
  });
  const focus = () => check(true);
  const visible = () => { if (!document.hidden) check(true); };
  window.addEventListener("focus", focus);
  document.addEventListener("visibilitychange", visible);
  dispose = () => {
    stopped = true;
    observer.disconnect();
    if (timer !== null) clearTimeout(timer);
    window.removeEventListener("focus", focus);
    document.removeEventListener("visibilitychange", visible);
  };
  check();
}

export function onUnload() {
  dispose?.();
  dispose = null;
}
