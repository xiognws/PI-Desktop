/**
 * Plugin host process (ADR 0008).
 *
 * One process hosts one or more plugins' main modules, outside the Electron main
 * process. It owns no host capability: every `pi.*` call is proxied back to the
 * broker in `plugin-runtime.ts`, where the permission gateway and the host API
 * allowlist live. Plain ESM JS (not TS) so the same file can be forked directly
 * by tests and bundled to `out/main/plugin-host-process.js` for the app.
 *
 * Multi-tenant: the process is shared, so `init` creates a tenant per plugin and
 * every frame names the tenant it belongs to. Each tenant owns its own module,
 * registrations, subscriptions and in-flight calls; a failure in one tenant is
 * answered to that tenant and never ends the process. Only a process-level fault
 * (OOM, an access violation, `process.exit` in plugin code) is shared.
 *
 * Wire protocol (both directions, one JSON message per frame). `pluginId` routes
 * a frame to its tenant on both sides and is required on every frame except the
 * `init` that creates the tenant; a host holding exactly one tenant accepts a
 * frame without it, which is what a per-plugin process always did.
 *   parent -> child  { t: "init", id, pluginId, pluginPath, main, manifest }
 *   parent -> child  { t: "call", id, pluginId, method, payload, invocationId? } command.run | tool.execute |
 *                                                        service.start | service.stop |
 *                                                        lifecycle.unload
 *   child  -> parent { t: "call", id, pluginId, api, args, invocationId? } host API request
 *   parent -> child  { t: "cancel", pluginId, invocationId | callId, reason } abort one call
 *   *      -> *      { t: "res", id, pluginId, ok, value } | { t: "res", id, ok: false, error: { code, message } }
 *   parent -> child  { t: "event", pluginId, event, ... }  push, no reply (bus.message, host events)
 *   child  -> parent { t: "log", pluginId, level, message } diagnostics, fire and forget
 */
import Module from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

const parentPort = process.parentPort;

/** Electron utilityProcess and node:child_process disagree on the transport. */
function send(message) {
  if (parentPort) parentPort.postMessage(message);
  else process.send?.(message);
}

function onHostMessage(handler) {
  if (parentPort) parentPort.on("message", (event) => handler(event.data));
  else process.on("message", handler);
}

function log(pluginId, level, message) {
  send({ t: "log", pluginId, level, message: String(message) });
}

/**
 * One tenant per plugin id: everything a plugin registers, awaits or subscribes
 * to lives here, never at module scope. A second `init` for the same id replaces
 * the tenant, which is what a reload expects.
 */
const tenants = new Map();

/** Host API calls awaiting the broker's answer, keyed by the id we handed out. */
const pending = new Map();
/** Tool/panel invocations currently running, per tenant (see `tenant.invocations`). */
const invocationContext = new AsyncLocalStorage();
/** The tenant whose code is running, so the shared `pi` global resolves to it. */
const tenantContext = new AsyncLocalStorage();
let nextCallId = 1;

function createTenant(message) {
  const pluginId = String(message.pluginId ?? "");
  return {
    pluginId,
    pluginPath: String(message.pluginPath ?? ""),
    manifest: message.manifest ?? { id: pluginId, name: pluginId, version: "", main: "", schemaVersion: 1 },
    module: null,
    /** Built in `handleInit`, before the plugin module is evaluated. */
    pi: null,
    commands: new Map(),
    tools: new Map(),
    speechHandles: new Map(),
    services: new Map(),
    busHandlers: new Map(),
    eventListeners: new Map(),
    /** Parent initiated OAuth callbacks, keyed by the parent's call id. */
    parentCallControllers: new Map(),
    /** Tool invocations in flight, keyed by the host's invocation id. */
    invocations: new Map(),
  };
}

/**
 * The tenant a frame belongs to. An untagged frame is only unambiguous when one
 * tenant exists — the per-plugin process case, and the only case that ever sent
 * untagged frames.
 */
function resolveTenant(message) {
  const pluginId = typeof message.pluginId === "string" ? message.pluginId : "";
  if (pluginId) return tenants.get(pluginId);
  if (tenants.size === 1) return [...tenants.values()][0];
  return undefined;
}

/** Proxy a host API call to the broker and await its verdict. */
function tenantCall(tenant, api, args = []) {
  const invocation = invocationContext.getStore();
  if (invocation && (invocation.controller.signal.aborted || tenant.invocations.get(invocation.id) !== invocation)) {
    return Promise.reject(invocation.controller.signal.reason ?? toolAbortedError("Plugin tool invocation finished"));
  }
  const id = `c${nextCallId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, invocationId: invocation?.id, tenant });
    try {
      send({ t: "call", pluginId: tenant.pluginId, id, api, args, ...(invocation ? { invocationId: invocation.id } : {}) });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

function toolAbortedError(reason) {
  return Object.assign(new Error(reason), { code: "PLUGIN_TOOL_ABORTED" });
}

/**
 * The same refusal the broker returns for the audio surface, for the two
 * synchronous registration helpers that cannot reject.
 */
function audioUnavailable(api) {
  return Object.assign(new Error(`host api not available: ${api}`), {
    code: "UNSUPPORTED",
  });
}

function rejectInvocationCalls(invocationId, error) {
  for (const [id, entry] of pending) {
    if (entry.invocationId !== invocationId) continue;
    pending.delete(id);
    entry.reject(error);
  }
}

function cancelInvocation(tenant, invocationId, reason) {
  const invocation = tenant.invocations.get(invocationId);
  if (!invocation || invocation.controller.signal.aborted) return;
  const error = toolAbortedError(reason || "Plugin tool execution aborted");
  invocation.controller.abort(error);
  rejectInvocationCalls(invocationId, error);
}

/**
 * Drop everything one tenant owns: in-flight tool invocations, OAuth callbacks
 * and host calls still waiting for an answer.
 *
 * This is the tenant-level stand-in for what killing a per-plugin process used
 * to do. The rest of the process keeps running, and the abandoned promises fail
 * with the same `PLUGIN_TOOL_ABORTED` / `PLUGIN_UNLOADED` codes the caller saw
 * before, so plugin code does not have to learn a new failure mode.
 */
function detachTenant(tenant, reason) {
  const error = toolAbortedError(reason);
  for (const id of [...tenant.invocations.keys()]) cancelInvocation(tenant, id, reason);
  for (const [id, controller] of tenant.parentCallControllers) {
    controller.abort(error);
    tenant.parentCallControllers.delete(id);
  }
  for (const [id, entry] of [...pending]) {
    if (entry.tenant !== tenant) continue;
    pending.delete(id);
    entry.reject(error);
  }
  if (tenants.get(tenant.pluginId) === tenant) tenants.delete(tenant.pluginId);
}

function settle(message) {
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) {
    entry.resolve(message.value);
    return;
  }
  const error = new Error(message.error?.message || "plugin host call failed");
  error.code = message.error?.code || "UNKNOWN";
  entry.reject(error);
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (!value || typeof value !== "object") return new Uint8Array();
  const bytes = Object.entries(value)
    .filter(([key]) => /^\d+$/.test(key))
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, byte]) => Number(byte));
  return Uint8Array.from(bytes);
}

function normalizeClipboardHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) =>
    entry?.type === "image"
      ? { ...entry, data: asUint8Array(entry.data) }
      : entry,
  );
}

function normalizeBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (!value || typeof value !== "object") return new Uint8Array();
  if (value.type === "Buffer" && Array.isArray(value.data)) {
    return Uint8Array.from(value.data);
  }
  return Uint8Array.from(
    Object.entries(value)
      .filter(([key]) => /^\d+$/.test(key))
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, byte]) => Number(byte)),
  );
}

// Contribution points, callables, host-call promises and subscriptions live on
// the tenant (`createTenant`), never here: two plugins in one process must not
// share a command table any more than they shared a process before.

/**
 * The `pi` global is process-wide; a plugin module reads it while it evaluates
 * and cannot be handed a private copy of the global. It resolves the tenant from
 * the running context instead, so `const pi = globalThis.pi` captured by one
 * plugin still reaches that plugin's own registrations and broker calls.
 * `AsyncLocalStorage` carries the tenant through timers and promises, which is
 * why a service loop started in `onLoad` keeps its own identity too.
 */
function currentTenant() {
  const active = tenantContext.getStore();
  if (active) return active;
  if (tenants.size === 1) return [...tenants.values()][0];
  const error = new Error("plugin host has no active plugin context");
  error.code = "PLUGIN_CONTEXT_MISSING";
  throw error;
}

globalThis.pi = new Proxy(
  {},
  {
    get(_target, group) {
      const api = currentTenant().pi;
      return api ? api[group] : undefined;
    },
  },
);

function buildApi(tenant) {
  const { commands, tools, speechHandles, services, busHandlers, eventListeners } = tenant;
  /** Every `pi.*` call crosses here, tagged with this tenant's id. */
  const call = (api, args) => tenantCall(tenant, api, args);
  return {
    app: {
      getVersion: () => call("app.getVersion"),
      getLocale: () => call("app.getLocale"),
      getAppearance: () => call("app.getAppearance"),
      setTheme: (themeId) => call("app.setTheme", [themeId]),
      isFocused: () => call("app.isFocused"),
      getFileIcon: (targetPath) => call("app.getFileIcon", [targetPath]),
    },
    themes: {
      upsert: (input) => call("themes.upsert", [input]),
      remove: (themeId) => call("themes.remove", [themeId]),
      list: () => call("themes.list"),
      setVariables: (themeId, values) => call("themes.setVariables", [themeId, values]),
    },
    plugin: {
      // Tenant-scoped: the module no longer holds a single plugin's identity,
      // so reading a bare `pluginId` here threw for every plugin after the
      // shared-host refactor.
      getId: () => tenant.pluginId,
      getManifest: () => tenant.manifest,
      getSettings: () => call("plugin.getSettings"),
      setSettings: (partial) => call("plugin.setSettings", [partial]),
      getDataPath: () => call("plugin.getDataPath"),
    },
    commands: {
      register: async (command) => {
        if (!command || typeof command.id !== "string" || !command.id) {
          throw new Error("command.id is required");
        }
        if (typeof command.run !== "function") {
          throw new Error("command.run must be a function");
        }
        commands.set(command.id, command.run);
        try {
          await call("commands.register", [
            {
              id: command.id,
              title: command.title,
              keywords: command.keywords,
              category: command.category,
            },
          ]);
        } catch (error) {
          commands.delete(command.id);
          throw error;
        }
      },
      unregister: async (id) => {
        commands.delete(id);
        await call("commands.unregister", [id]);
      },
    },
    speech: {
      registerAdapter: async (adapter) => {
        if (!adapter || typeof adapter.protocol !== "string" || !adapter.protocol.trim()) {
          throw new Error("speech protocol is required");
        }
        if (typeof adapter.handle !== "function") {
          throw new Error("speech handle must be a function");
        }
        const protocol = adapter.protocol.trim();
        const roles = Array.isArray(adapter.roles) ? adapter.roles : [];
        speechHandles.set(protocol, adapter.handle);
        try {
          await call("speech.registerAdapter", [
            {
              protocol,
              label: adapter.label,
              roles,
            },
          ]);
        } catch (error) {
          speechHandles.delete(protocol);
          throw error;
        }
      },
      unregisterAdapter: async (protocol) => {
        speechHandles.delete(String(protocol ?? ""));
        await call("speech.unregisterAdapter", [protocol]);
      },
    },
    ui: {
      openPanel: (options) => call("ui.openPanel", [options]),
      closePanel: () => call("ui.closePanel"),
      showToast: (message, level) => call("ui.showToast", [message, level]),
      // The work panel is the shell's own surface: the plugin names one of its
      // declared views and the subject, and the main process refuses a session
      // that stopped being the one the user is looking at.
      revealView: (input) => call("ui.revealView", [input ?? {}]),
      notify: (input) => call("ui.notify", [input]),
      getNotificationPermission: () => call("ui.getNotificationPermission"),
      requestNotificationPermission: () => call("ui.requestNotificationPermission"),
      showNativeNotification: (input) => call("ui.showNativeNotification", [input]),
    },
    // One line into the session's composer placeholder (ADR 0333). The shell
    // answers whether it went on screen, so a plugin never has to guess before
    // spending another completion.
    composer: {
      suggest: (input) => call("composer.suggest", [input ?? {}]),
      clearSuggestion: (input) => call("composer.clearSuggestion", [input ?? {}]),
    },
    project: {
      create: (input) => call("project.create", [input ?? {}]),
    },
    providers: {
      oauth: {
        prompt: (loginId, input) => call("providers.oauth.prompt", [loginId, input]),
        notify: (loginId, event) => call("providers.oauth.notify", [loginId, event]),
      },
    },
    workspace: {
      get: () => call("workspace.get"),
    },
    projects: {
      list: () => call("projects.list"),
    },
    desktop: {
      listOperations: () => call("desktop.listOperations"),
      invoke: (input) => call("desktop.invoke", [input ?? {}]),
    },
    fs: {
      readText: (path) => call("fs.readText", [path]),
      stat: (path, grantId) => call("fs.stat", [path, grantId]),
      readRange: (path, byteOffset, length, grantId) =>
        call("fs.readRange", [path, byteOffset, length, grantId]).then((result) => ({
          ...result,
          bytes: normalizeBytes(result?.bytes),
        })),
      readPreview: (path, options) => call("fs.readPreview", options === undefined ? [path] : [path, options]),
      openDefault: (path) => call("fs.openDefault", [path]),
      openInBrowser: (path) => call("fs.openInBrowser", [path]),
      reveal: (path) => call("fs.reveal", [path]),
      writeText: (path, content) => call("fs.writeText", [path, content]),
      glob: (pattern) => call("fs.glob", [pattern]),
      list: (path, options) => call("fs.list", options === undefined ? [path] : [path, options]),
      remove: (path) => call("fs.remove", [path]),
      requestDirectory: () => call("fs.requestDirectory"),
    },
    agent: {
      registerTool: async (tool) => {
        if (!tool || typeof tool.name !== "string" || !tool.name) {
          throw new Error("tool.name is required");
        }
        if (typeof tool.execute !== "function") {
          throw new Error("tool.execute must be a function");
        }
        tools.set(tool.name, tool.execute);
        try {
          await call("agent.registerTool", [
            {
              name: tool.name,
              description: tool.description,
              risk: tool.risk,
              schema: tool.schema,
            },
          ]);
        } catch (error) {
          tools.delete(tool.name);
          throw error;
        }
      },
      unregisterTool: async (name) => {
        tools.delete(name);
        await call("agent.unregisterTool", [name]);
      },
      complete: (input) => call("agent.complete", [input ?? {}]),
    },
    models: {
      list: () => call("models.list"),
    },
    session: {
      // The selected session, as the shell shows it. A snapshot is a value: a
      // plugin compares `sessionId` rather than assuming the session still holds.
      getActive: () => call("session.getActive"),
      getLlmContext: () => call("session.getLlmContext"),
      getAutoTitleContext: (input) => call("session.getAutoTitleContext", [input ?? {}]),
      setAutoTitle: (input) => call("session.setAutoTitle", [input ?? {}]),
      list: (input) => call("session.list", [input ?? {}]),
      get: (input) => call("session.get", [input ?? {}]),
      listMessages: (input) => call("session.listMessages", [input ?? {}]),
      import: (input) => call("session.import", [input ?? {}]),
      importBatch: (input) => call("session.importBatch", [input ?? {}]),
      rename: (input) => call("session.rename", [input ?? {}]),
      delete: (input) => call("session.delete", [input ?? {}]),
      // Message-level writes (`session.update.all` / `session.delete.all`, ADR
      // 0339). The plugin supplies no scope: the main-process gateway derives it
      // from the granted permissions.
      appendMessage: (input) => call("session.appendMessage", [input ?? {}]),
      replaceMessages: (input) => call("session.replaceMessages", [input ?? {}]),
      deleteMessage: (input) => call("session.deleteMessage", [input ?? {}]),
      truncateFrom: (input) => call("session.truncateFrom", [input ?? {}]),
    },
    // Read-only usage facts (`usage.read`). The main-process dispatch owns
    // the permission check and parameter bounds; the host returns per-turn
    // counters and identifiers only, so no message body crosses this bridge.
    usage: {
      listTurns: (input) => call("usage.listTurns", [input ?? {}]),
      // The host already aggregates the ledger (tokens plus money per
      // provider/model), so a dashboard does not page turns to add dollars.
      summary: (input) => call("usage.summary", [input ?? {}]),
    },
    /**
     * Resident background workers (spec 07 §3). Registration is local: the
     * manifest already declared the service, and the broker starts it only when
     * `background.service` was granted — so a plugin that registers without the
     * permission simply never runs.
     */
    services: {
      register: (service) => {
        if (!service || typeof service.id !== "string" || !service.id) {
          throw new Error("service.id is required");
        }
        if (typeof service.start !== "function") {
          throw new Error("service.start must be a function");
        }
        services.set(service.id, {
          start: service.start,
          stop: typeof service.stop === "function" ? service.stop : undefined,
          running: false,
        });
      },
      unregister: async (id) => {
        const entry = services.get(String(id ?? ""));
        services.delete(String(id ?? ""));
        if (entry?.running && entry.stop) await entry.stop();
      },
    },
    /**
     * Inter-plugin message bus (spec 07 §3). Topics must be declared in
     * `contributes.bus`; the broker owns the routing table, so this side only
     * keeps the handler for each subscription it was given.
     */
    bus: {
      publish: (topic, payload) => call("bus.publish", [topic, payload]),
      subscribe: async (topic, handler) => {
        if (typeof handler !== "function") {
          throw new Error("bus.subscribe handler must be a function");
        }
        const result = await call("bus.subscribe", [topic]);
        const id = String(result?.subscriptionId ?? "");
        busHandlers.set(id, handler);
        return async () => {
          busHandlers.delete(id);
          await call("bus.unsubscribe", [id]);
        };
      },
    },
    clipboard: {
      readText: () => call("clipboard.readText"),
      writeText: (text) => call("clipboard.writeText", [text]),
      getHistory: () => call("clipboard.getHistory").then(normalizeClipboardHistory),
    },
    shell: {
      openExternal: (url) => call("shell.openExternal", [url]),
    },
    browser: {
      reveal: () => call("browser.reveal"),
      navigate: (input) => call("browser.navigate", [input ?? {}]),
      action: (input) => call("browser.action", [input]),
      setBounds: (hole) => call("browser.setBounds", [hole]),
      setVisible: (visible) => call("browser.setVisible", [visible]),
      getState: () => call("browser.getState"),
      openExternal: () => call("browser.openExternal"),
      snapshot: () => call("browser.snapshot"),
      screenshot: (input) => call("browser.screenshot", [input ?? {}]),
      click: (input) => call("browser.click", [input]),
      fill: (input) => call("browser.fill", [input]),
      evaluate: (input) => call("browser.evaluate", [input]),
      console: (input) => call("browser.console", [input ?? {}]),
      cdp: (input) => call("browser.cdp", [input]),
    },
    net: {
      getCapabilities: () => call("net.getCapabilities"),
      fetch: (input) => call("net.fetch", [input]),
      // Real-time connections (`net.websocket`). Frames arrive back as
      // `net:websocket:message` host events, so a plugin subscribes with
      // `pi.events.on` exactly as it does for any other host event.
      websocket: {
        connect: (input) => call("net.websocket.connect", [input ?? {}]),
        send: (input) => call("net.websocket.send", [input ?? {}]),
        close: (input) => call("net.websocket.close", [input ?? {}]),
      },
    },
    /**
     * Background audio (`audio.capture.background`, `audio.playback.background`).
     * The host has no device backend yet, so the async calls travel to the
     * broker and come back as a coded `UNSUPPORTED` refusal — a plugin can
     * branch on `error.code` instead of catching a TypeError. The two
     * registration helpers are synchronous by contract and cannot reject, so
     * they throw the same refusal immediately rather than registering a handler
     * that could never fire.
     */
    audio: {
      getInputDevices: () => call("audio.getInputDevices"),
      openInput: (options) => call("audio.openInput", [options ?? {}]),
      closeInput: (streamId) => call("audio.closeInput", [streamId]),
      getCaptureState: () => call("audio.getCaptureState"),
      onInputFrame: () => {
        throw audioUnavailable("audio.onInputFrame");
      },
      offInputFrame: () => {
        throw audioUnavailable("audio.offInputFrame");
      },
      openOutput: (options) => call("audio.openOutput", [options ?? {}]),
      writeOutput: (input) => call("audio.writeOutput", [input ?? {}]),
      stopOutput: (streamId) => call("audio.stopOutput", [streamId]),
      closeOutput: (streamId) => call("audio.closeOutput", [streamId]),
    },
    // System-wide accelerators. The arrow handlers live in the host: this
    // object only carries requests across the boundary.
    keyboard: {
      registerGlobalShortcut: (input) => call("keyboard.registerGlobalShortcut", [input]),
      unregisterGlobalShortcut: (id) => call("keyboard.unregisterGlobalShortcut", [id]),
      listGlobalShortcuts: () => call("keyboard.listGlobalShortcuts"),
    },
    // Fed by the parent's `event` frames; bus deliveries also arrive as
    // `bus.message` here, so a plugin can watch the raw stream if it wants to.
    events: {
      on: (event, handler) => {
        if (typeof handler !== "function") return;
        const listeners = eventListeners.get(event) ?? new Set();
        listeners.add(handler);
        eventListeners.set(event, listeners);
      },
      off: (event, handler) => {
        eventListeners.get(event)?.delete(handler);
      },
    },
  };
}

/** Dispatch one parent push frame; a throwing handler must not kill the plugin. */
function handleHostEvent(tenant, message) {
  const { busHandlers, eventListeners } = tenant;
  const event = String(message.event ?? "");
  if (event === "bus.message") {
    const handler = busHandlers.get(String(message.subscriptionId ?? ""));
    if (handler) {
      try {
        handler(message.message);
      } catch (error) {
        log(tenant.pluginId, "warn", `bus handler failed for ${message.message?.topic}: ${error?.message ?? error}`);
      }
    }
  }
  const args = message.args ?? [message.message];
  for (const listener of [...(eventListeners.get(event) ?? [])]) {
    try {
      listener(...args);
    } catch (error) {
      log(tenant.pluginId, "warn", `event handler failed for ${event}: ${error?.message ?? error}`);
    }
  }
}

/**
 * Load a plugin's `main` as CommonJS even when the file is treated as ESM.
 *
 * A bundled plugin is a folder with `main.js`, no `package.json` of its own, and
 * CommonJS source. Node decides the module type by the *nearest* `package.json`,
 * which can be the app's own (`"type": "module"`): `require()` then refuses with
 * ERR_REQUIRE_ESM and the ESM loader dies on `module is not defined`. Compiling
 * the source as CJS gives the plugin exactly the resolution rules it would get
 * from a `.cjs` file, without shipping a package.json into every plugin folder.
 */
function compileAsCommonJs(entry) {
  const mod = new Module(entry);
  mod.filename = entry;
  mod.paths = Module._nodeModulePaths(dirname(entry));
  mod._compile(readFileSync(entry, "utf8"), entry);
  return mod.exports;
}

/**
 * The plugin's syntax decides how it is loaded, not the nearest `package.json`.
 *
 * Bundled plugins are plain CommonJS sources with no `package.json` of their own,
 * so Node falls back to the app's `"type": "module"` and either refuses to
 * `require()` them or evaluates them as ESM and dies on `module.exports`. Which
 * ancestor happens to declare a module type is not the plugin author's business,
 * so the entry file is inspected: `.mjs` is ESM, `.cjs` is CommonJS, and a `.js`
 * entry is ESM only when it actually uses `import`/`export` syntax.
 */
function isEsmSource(entry, source) {
  if (entry.endsWith(".mjs")) return true;
  if (entry.endsWith(".cjs")) return false;
  return /^\s*(import|export)\s/m.test(source) || /\bimport\.meta\b/.test(source);
}

/**
 * A CommonJS plugin needs a `package.json` of its own, not just a CJS entry.
 *
 * The host only decides how to load the entry file; everything the plugin then
 * `require()`s is resolved by Node's own rules, which walk up to the nearest
 * `package.json` — the app's own `"type": "module"` when the plugin ships none.
 * Its submodules were then evaluated as ESM (`require is not defined`). Writing
 * the one field the folder is missing keeps the whole plugin tree CommonJS, the
 * way it was authored; a plugin that ships its own package.json is left alone.
 */
function ensureCommonJsPackage(entry, pluginPath) {
  const pkgPath = join(pluginPath, "package.json");
  if (existsSync(pkgPath)) return;
  if (isEsmSource(entry, readFileSync(entry, "utf8"))) return;
  try {
    writeFileSync(pkgPath, `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}\n`);
  } catch {
    // Read-only install: the entry still loads below, submodules may not.
  }
}

async function loadPluginModule(entry) {
  const source = readFileSync(entry, "utf8");
  if (!isEsmSource(entry, source)) return compileAsCommonJs(entry);
  const mod = await import(`${pathToFileURL(entry).href}?t=${Date.now()}`);
  return mod?.default && typeof mod.default === "object" ? mod.default : mod;
}

/**
 * Create (or replace) one tenant and run its `onLoad`.
 *
 * Everything a plugin does while loading — module evaluation, `pi.*` calls,
 * `onLoad` — runs inside this tenant's context, so the shared `pi` global and the
 * broker see the right owner. A failure here drops this tenant only: the
 * `init` frame is answered with the error, and every other tenant in the process
 * keeps running.
 */
async function handleInit(message) {
  const pluginId = String(message.pluginId ?? "");
  if (!pluginId) {
    const error = new Error("plugin host init requires a plugin id");
    error.code = "PLUGIN_INVALID";
    throw error;
  }
  const previous = tenants.get(pluginId);
  if (previous) detachTenant(previous, "Plugin reloaded");

  const tenant = createTenant(message);
  tenants.set(pluginId, tenant);
  const entry = join(tenant.pluginPath, String(message.main ?? tenant.manifest.main ?? ""));
  tenant.pi = buildApi(tenant);
  try {
    await tenantContext.run(tenant, async () => {
      ensureCommonJsPackage(entry, tenant.pluginPath);
      tenant.module = await loadPluginModule(entry);
      const oauthProviders = Array.isArray(tenant.manifest?.contributes?.providers)
        ? tenant.manifest.contributes.providers.filter((provider) => provider?.authKind === "oauth")
        : [];
      if (oauthProviders.length > 0 && typeof tenant.module?.onProviderOAuth !== "function") {
        const error = new Error("OAuth providers require an onProviderOAuth hook");
        error.code = "PLUGIN_INVALID";
        throw error;
      }
      if (tenant.module?.onLoad) await tenant.module.onLoad();
    });
  } catch (error) {
    detachTenant(tenant, "Plugin failed to load");
    throw error;
  }
  return { pluginId };
}

async function handleParentCall(tenant, method, payload, invocationId, callId) {
  // Aliases only: the dispatch below is the same switch it always was, now
  // reading this tenant's tables instead of the process's.
  const { commands, tools, speechHandles, services, parentCallControllers, invocations } = tenant;
  const pluginModule = tenant.module;
  switch (method) {
    case "panel.invoke": {
      const invoke = pluginModule?.onPanelInvoke;
      if (typeof invoke !== "function") {
        const error = new Error("plugin does not expose panel operations");
        error.code = "UNSUPPORTED";
        throw error;
      }
      return invoke(String(payload?.channel ?? ""), payload?.payload ?? {});
    }
    case "provider.oauth": {
      const handle = pluginModule?.onProviderOAuth;
      if (typeof handle !== "function") {
        const error = new Error("plugin does not expose provider OAuth operations");
        error.code = "UNSUPPORTED";
        throw error;
      }
      if (typeof callId !== "string" || !callId || parentCallControllers.has(callId)) {
        const error = new Error("provider OAuth requires a unique parent call ID");
        error.code = "INVALID_ARGUMENT";
        throw error;
      }
      const controller = new AbortController();
      parentCallControllers.set(callId, controller);
      try {
        return await handle(payload ?? {}, { signal: controller.signal });
      } finally {
        parentCallControllers.delete(callId);
      }
    }
    case "command.run": {
      const run = commands.get(String(payload?.id ?? ""));
      if (!run) {
        const error = new Error(`command not registered: ${payload?.id}`);
        error.code = "NOT_FOUND";
        throw error;
      }
      await run();
      return { ok: true };
    }
    case "speech.handle": {
      const handle = speechHandles.get(String(payload?.protocol ?? ""));
      if (!handle) {
        const error = new Error(`speech adapter not registered: ${payload?.protocol}`);
        error.code = "NOT_FOUND";
        throw error;
      }
      return handle(payload ?? {});
    }
    case "tool.execute": {
      if (typeof invocationId !== "string" || !invocationId || invocations.has(invocationId)) {
        throw toolAbortedError("A unique host tool invocation ID is required");
      }
      const execute = tools.get(String(payload?.name ?? ""));
      if (!execute) {
        const error = new Error(`tool not registered: ${payload?.name}`);
        error.code = "TOOL_NOT_FOUND";
        throw error;
      }
      const invocation = { id: invocationId, controller: new AbortController() };
      invocations.set(invocationId, invocation);
      try {
        const result = await invocationContext.run(invocation, () => execute(payload?.args, {
          sessionId: payload?.sessionId,
          turnId: payload?.turnId,
          mode: payload?.mode,
          modelKey: payload?.modelKey,
          thinkingLevel: payload?.thinkingLevel,
          signal: invocation.controller.signal,
          log: (msg) => log(tenant.pluginId, "info", msg),
        }));
        return result ?? null;
      } finally {
        invocations.delete(invocationId);
        rejectInvocationCalls(invocationId, toolAbortedError("Plugin tool invocation finished"));
      }
    }
    case "service.start": {
      const id = String(payload?.id ?? "");
      const entry = services.get(id);
      if (!entry) {
        const error = new Error(`service not registered: ${id}`);
        error.code = "NOT_FOUND";
        throw error;
      }
      // Idempotent: a restart of the host process re-runs start, but a second
      // start inside one process must not spawn a duplicate worker.
      if (entry.running) return { ok: true, alreadyRunning: true };
      await entry.start({ log: (msg) => log(tenant.pluginId, "info", msg) });
      entry.running = true;
      return { ok: true };
    }
    case "service.stop": {
      const entry = services.get(String(payload?.id ?? ""));
      if (!entry?.running) return { ok: true };
      entry.running = false;
      if (entry.stop) await entry.stop();
      return { ok: true };
    }
    case "renderer.call": {
      const handler = pluginModule?.onRendererCall;
      if (typeof handler !== "function") {
        const error = new Error("plugin does not implement onRendererCall");
        error.code = "PLUGIN_CALL_NO_HANDLER";
        throw error;
      }
      const answer = await handler(String(payload?.method ?? ""), payload?.args ?? {});
      // The relay answers JSON only. A cycle, a BigInt or a bare function is
      // the plugin's bug and is reported as one, instead of surfacing as a
      // structured-clone failure without a code.
      let text;
      try {
        text = JSON.stringify(answer ?? null);
      } catch {
        text = undefined;
      }
      if (text === undefined) {
        const error = new Error("onRendererCall answer is not JSON");
        error.code = "PLUGIN_CALL_UNSERIALIZABLE";
        throw error;
      }
      return JSON.parse(text);
    }
    case "composer.transform": {
      const handler = pluginModule?.onComposerTransform;
      if (typeof handler !== "function") {
        const error = new Error("plugin does not implement onComposerTransform");
        error.code = "PLUGIN_TRANSFORM_NO_HANDLER";
        throw error;
      }
      const answer = await handler({
        id: String(payload?.id ?? ""),
        text: String(payload?.text ?? ""),
        ...(typeof payload?.modelKey === "string" ? { modelKey: payload.modelKey } : {}),
      });
      if (typeof answer !== "string") {
        const error = new Error("onComposerTransform must return a text string");
        error.code = "PLUGIN_INVALID_RESULT";
        throw error;
      }
      return answer;
    }
    case "lifecycle.unload": {
      for (const id of [...invocations.keys()]) cancelInvocation(tenant, id, "Plugin unloaded");
      for (const [id, controller] of parentCallControllers) {
        controller.abort(toolAbortedError("Plugin unloaded"));
        parentCallControllers.delete(id);
      }
      // Best effort: a throwing onUnload must not block teardown.
      try {
        if (pluginModule?.onUnload) await pluginModule.onUnload();
      } catch (error) {
        log(tenant.pluginId, "warn", `onUnload failed: ${error?.message ?? error}`);
      }
      // Tenant teardown, not process teardown: whatever this plugin still had in
      // flight fails now (the same codes a killed process produced), its
      // registrations go with it, and the other tenants never notice.
      detachTenant(tenant, "Plugin unloaded");
      return { ok: true };
    }
    default: {
      const error = new Error(`unknown method: ${method}`);
      error.code = "UNSUPPORTED";
      throw error;
    }
  }
}

/**
 * Route one parent frame to its tenant.
 *
 * Routing is by `pluginId` — the only field that says whose frame this is. `id`
 * is the correlation id *inside* a tenant and repeats across tenants (`h1` is
 * the first call of every plugin), so it can never be the routing key. A frame
 * for a tenant this process does not hold is answered with `PLUGIN_NOT_LOADED`
 * rather than applied to somebody else's tables.
 */
function replyTo(message, pluginId, error, value) {
  if (error) {
    send({
      t: "res",
      id: message.id,
      pluginId,
      ok: false,
      error: {
        code: error?.code || "PLUGIN_CALL_FAILED",
        message: error?.message ? String(error.message) : String(error),
      },
    });
    return;
  }
  send({ t: "res", id: message.id, pluginId, ok: true, value: value ?? null });
}

onHostMessage((message) => {
  if (!message || typeof message !== "object") return;
  if (message.t === "res") {
    settle(message);
    return;
  }
  if (message.t === "init") {
    void handleInit(message)
      .then((value) => replyTo(message, value.pluginId, null, value))
      .catch((error) => replyTo(message, String(message.pluginId ?? ""), error));
    return;
  }
  const tenant = resolveTenant(message);
  if (!tenant) {
    // An event has no answer to give; anything else gets the coded refusal its
    // sender is waiting for.
    if (message.t !== "event") {
      replyTo(message, String(message.pluginId ?? ""), Object.assign(
        new Error(`no plugin tenant for: ${message.pluginId ?? "(unset pluginId)"}`),
        { code: "PLUGIN_NOT_LOADED" },
      ));
    }
    return;
  }
  if (message.t === "event") {
    handleHostEvent(tenant, message);
    return;
  }
  if (message.t === "cancel") {
    if (typeof message.callId === "string") {
      const controller = tenant.parentCallControllers.get(message.callId);
      if (controller && !controller.signal.aborted) {
        controller.abort(toolAbortedError(String(message.reason ?? "Plugin call cancelled")));
      }
    }
    cancelInvocation(tenant, message.invocationId, String(message.reason ?? ""));
    return;
  }
  if (message.t === "call") {
    // One tenant's failure is answered to that tenant and stops there: the
    // process keeps serving every other plugin, which is the whole point of the
    // shared host. Only a process-level fault (OOM, an access violation,
    // `process.exit` in plugin code) reaches every tenant at once.
    void tenantContext.run(tenant, () =>
      invocationContext.run(undefined, () =>
        handleParentCall(tenant, message.method, message.payload, message.invocationId, message.id),
      ),
    )
      .then((value) => replyTo(message, tenant.pluginId, null, value))
      .catch((error) => replyTo(message, tenant.pluginId, error));
  }
});

// A misbehaving plugin must not take down its own host process silently, and it
// can never take down the app: the broker owns teardown decisions.
process.on("uncaughtException", (error) => {
  log(undefined, "error", `uncaught exception: ${error?.stack || error}`);
});
process.on("unhandledRejection", (reason) => {
  log(undefined, "error", `unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
