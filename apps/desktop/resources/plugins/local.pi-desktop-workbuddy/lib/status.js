var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var status_exports = {};
__export(status_exports, {
  buildStatus: () => buildStatus,
  formatRates: () => formatRates,
  formatStatus: () => formatStatus
});
module.exports = __toCommonJS(status_exports);
async function buildStatus(options) {
  const { pool, catalog, client } = options;
  const accounts = pool.list();
  const now = Date.now();
  const rows = [];
  for (const account of accounts) {
    const modelCooldowns = Object.entries(account.modelCooldowns).filter(([, until]) => until > now).sort((a, b) => a[1] - b[1]).map(([modelId, until]) => ({ modelId, until: new Date(until).toISOString() }));
    const row = {
      id: account.id,
      label: account.label,
      ...account.credential.nickname === void 0 ? {} : { nickname: account.credential.nickname },
      domain: account.credential.domain,
      ...account.credential.expiresAtMs === 0 ? {} : { expiresAt: new Date(account.credential.expiresAtMs).toISOString() },
      cooling: account.cooldownUntilMs > now,
      ...account.cooldownUntilMs > now ? { cooldownUntil: new Date(account.cooldownUntilMs).toISOString() } : {},
      ...modelCooldowns.length === 0 ? {} : { modelCooldowns },
      rateLimitHits: account.rateLimitHits,
      sourcePath: account.credential.sourcePath
    };
    if (options.includeCredits === true && !row.cooling) {
      try {
        Object.assign(row, { credits: await client.fetchCredits(account.credential) });
      } catch (error) {
        Object.assign(row, { creditsError: String(error).slice(0, 200) });
      }
    }
    rows.push(row);
  }
  const cooling = rows.filter((row) => row.cooling).length;
  const firstUsable = accounts.find((account) => account.cooldownUntilMs <= now);
  return {
    ok: accounts.length > 0 && cooling < accounts.length,
    accounts: rows,
    ...firstUsable === void 0 ? {} : { activeAccountId: firstUsable.id },
    cooling,
    models: catalog.current().map((model) => ({
      id: model.id,
      name: model.name,
      ...model.multiplier === void 0 ? {} : { multiplier: model.multiplier },
      ...model.tags === void 0 ? {} : { tags: model.tags }
    })),
    shim: options.shim ?? { running: false }
  };
}
function formatStatus(status) {
  const lines = [];
  lines.push(`pi-desktop-workbuddy: ${status.accounts.length} account(s), ${status.cooling} cooling`);
  lines.push(`Shim: ${status.shim.running ? "running" : "stopped"}${status.shim.baseUrl === void 0 ? "" : ` at ${status.shim.baseUrl}`}`);
  lines.push("");
  if (status.accounts.length === 0) {
    lines.push("No WorkBuddy credential found. Sign in on the WorkBuddy desktop app,");
    lines.push("then run: dsh plugin --profile desktop exec dsh-workbuddy-xdpool import <key>");
    return lines.join("\n");
  }
  for (const account of status.accounts) {
    const flag = account.cooling ? "\u23F8 " : "\u25B6 ";
    const active = account.id === status.activeAccountId ? " (next up)" : "";
    lines.push(`${flag}${account.label}${active}`);
    lines.push(`    uid/uin   : ${account.id}  [${account.domain || "cn"}]`);
    if (account.expiresAt !== void 0) lines.push(`    expires   : ${account.expiresAt}`);
    if (account.credits !== void 0) {
      const { total } = account.credits;
      const parts = [];
      if (total !== void 0) parts.push(`total ${total}`);
      lines.push(`    credits   : ${parts.join(" | ") || "n/a"}`);
    }
    if (account.creditsError !== void 0) lines.push(`    credits   : query failed \u2014 ${account.creditsError}`);
    if (account.cooling && account.cooldownUntil !== void 0) {
      lines.push(`    cooldown  : until ${account.cooldownUntil} (hits ${account.rateLimitHits})`);
    }
    if (account.modelCooldowns !== void 0 && account.modelCooldowns.length > 0) {
      for (const mc of account.modelCooldowns) {
        lines.push(`    model-cool: ${mc.modelId} until ${mc.until}`);
      }
    }
    lines.push(`    source    : ${account.sourcePath}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
function formatRates(status) {
  const lines = ["Model credit multipliers:"];
  for (const model of status.models) {
    const rate = model.multiplier === void 0 ? "x?" : `x${model.multiplier.toFixed(2)}`;
    lines.push(`  ${model.name.padEnd(20)} ${rate}`);
  }
  return lines.join("\n");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildStatus,
  formatRates,
  formatStatus
});
