'use strict';
// In-app gateway host.
//
// Runs one entry of `IN_APP_PROVIDERS` in its own process so a crashing or
// hung upstream adapter cannot take the Electron main process with it. The
// HTTP surface itself is the vendored bridge (`server.cjs`, MIT, taken from
// `community.workbuddy-connect`); this file is only the transport shim:
//
//   parent -> child  { type: 'start', port, key, home }
//   parent -> child  { type: 'stop' }
//   child  -> parent { type: 'ready', port } | { type: 'error', message }
//
// Electron's utilityProcess and node:child_process disagree on the transport,
// so the same file serves both (see `plugin-host-process.mjs`).
const { startBridge } = require('./server.cjs');

const parentPort = process.parentPort;

function send(message) {
  if (parentPort) parentPort.postMessage(message);
  else process.send?.(message);
}

function onParentMessage(handler) {
  if (parentPort) parentPort.on('message', (event) => handler(event.data));
  else process.on('message', handler);
}

let bridge;
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    if (bridge) await bridge.close();
  } catch {
    // A closed port is already the state we wanted.
  }
  bridge = undefined;
}

/**
 * The dashboard the vendored bridge mounts is a browser admin panel for the
 * plugin. The in-app provider has no such page, so the automation hooks it
 * would call are answered here instead of loading the Windows task scheduler
 * helpers, which are plugin-only.
 */
function dashboardSystem() {
  return {
    automationStatus: async () => ({ state: 'in-app', enabled: true }),
    setAutomation: async () => {
      throw new Error('Managed by the in-app provider supervisor');
    },
    stopSupervisor: async () => {},
    saveKey: async (value) => {
      if (typeof value !== 'string' || value.length < 32) throw new Error('Local API key must have at least 32 characters');
      const { mkdir, writeFile } = require('node:fs/promises');
      const { join } = require('node:path');
      await mkdir(process.env.PI_WORKBUDDY_HOME, { recursive: true });
      await writeFile(join(process.env.PI_WORKBUDDY_HOME, 'local-api-key'), `${value}\n`, { mode: 0o600 });
    },
  };
}

async function start({ port, key }) {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid in-app provider port: ${String(port)}`);
  }
  bridge = await startBridge({
    key,
    port,
    autoRefresh: true,
    owner: 'in-app',
    dashboardSystem: dashboardSystem(),
  });
  send({ type: 'ready', port: bridge.port });
}

onParentMessage((message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'start') {
    void start(message).catch((error) => {
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      void stop();
    });
    return;
  }
  if (message.type === 'stop') {
    void stop().then(() => process.exit(0));
  }
});

// The parent going away must not leave this process holding the loopback port.
process.on('disconnect', () => void stop().then(() => process.exit(0)));
process.on('SIGTERM', () => void stop().then(() => process.exit(0)));
