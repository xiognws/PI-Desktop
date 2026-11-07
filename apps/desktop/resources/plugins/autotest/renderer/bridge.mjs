// Renderer-side bridge to the plugin host process.
// Every call is one plugin.call (2s timeout, <=64KB, <=10/s): never poll in a loop.

let bound = null;

export function bindBridge(pi) {
  bound = pi;
}

export function bridge() {
  if (!bound) throw Object.assign(new Error('autotest renderer is not loaded'), { code: 'BRIDGE_UNBOUND' });
  return bound;
}

export function pluginId() {
  return bound && bound.plugin ? bound.plugin.id : 'pi.autotest';
}

// One dispatch round-trip. Resolves to the answer payload; on failure the host
// puts a code on the error, which the UI shows instead of a generic message.
//
// The argument key is `args`: the host reads `payload.method` and
// `payload.args` (apps/desktop/src/plugins/renderer-host/dispatch.ts:118-127)
// and forwards only `args` to the plugin host process. Sending `payload` made
// every renderer call arrive with undefined arguments, so approve/select/status
// silently queried the wrong plan.
export async function call(method, args) {
  const pi = bridge();
  return await pi.dispatch('plugin.call', { method, args: args || {} });
}

export function callError(error) {
  if (!error) return 'UNKNOWN';
  return error.code || error.message || 'UNKNOWN';
}

export function formatMs(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return ms + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
  return Math.round(ms / 60000) + ' min';
}

export function shortId(id) {
  if (!id || typeof id !== 'string') return '';
  return id.length <= 34 ? id : id.slice(0, 31) + '...';
}
