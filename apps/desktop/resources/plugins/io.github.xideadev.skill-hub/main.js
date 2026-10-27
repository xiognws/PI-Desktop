"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execSync } = require("node:child_process");
const store = require("./src/skill-store.js");

const DATA_DIR = path.join(__dirname, "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const DB_FILE = path.join(os.homedir(), ".pi-desktop", "pi.sqlite");

function loadConfig() {
  store.ensureDir(DATA_DIR);
  if (!fs.existsSync(CONFIG_FILE)) {
    const initial = {
      schemaVersion: 1,
      enabledSkills: {},
      directInjections: {},
      projectBindings: {},
      sessionBindings: {}
    };
    store.atomicWrite(CONFIG_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return { enabledSkills: {}, directInjections: {}, projectBindings: {}, sessionBindings: {} };
  }
}

function saveConfig(cfg) {
  store.ensureDir(DATA_DIR);
  store.atomicWrite(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function getHostPi() {
  if (typeof pi !== "undefined" && pi) return pi;
  if (typeof globalThis !== "undefined" && globalThis.pi) return globalThis.pi;
  return null;
}

/**
 * 智能解析当前活跃工作区路径
 */
async function resolveWorkspacePath(payloadWorkspace) {
  if (payloadWorkspace && typeof payloadWorkspace === "string" && fs.existsSync(payloadWorkspace)) {
    return payloadWorkspace;
  }

  // 1. 优先调用官方 API
  const p = getHostPi();
  if (p && p.workspace && typeof p.workspace.get === "function") {
    try {
      const ws = await p.workspace.get();
      if (ws && ws.path && fs.existsSync(ws.path)) {
        return String(ws.path).trim();
      }
    } catch {}
  }

  // 2. 查询宿主本地数据库中最近活跃的项目路径
  if (fs.existsSync(DB_FILE)) {
    try {
      const out = execSync(`sqlite3 "${DB_FILE}" "SELECT path FROM projects ORDER BY rowid DESC LIMIT 1;" 2>/dev/null`)
        .toString()
        .trim();
      if (out && fs.existsSync(out)) {
        return out;
      }
    } catch {}
  }

  // 3. 兜底
  return process.cwd();
}

/**
 * 宿主面板 RPC 转发入口
 */
async function onPanelInvoke(channel, payload = {}) {
  const cfg = loadConfig();
  const currentWorkspace = await resolveWorkspacePath(payload && payload.workspace);

  switch (channel) {
    case "skills.list": {
      const globalSkills = store.scanAllGlobalSkills();
      const projectSkills = currentWorkspace 
        ? store.scanSkillsInDir(store.getProjectSkillsDir(currentWorkspace), "project")
        : [];
      
      const all = [...globalSkills, ...projectSkills];
      const skills = all.map(s => ({
        ...s,
        enabled: cfg.enabledSkills[s.id] !== false,
        injectionType: cfg.directInjections[s.id] ? "direct" : "index"
      }));

      return {
        ok: true,
        skills,
        config: cfg,
        globalDir: store.getPrimaryGlobalDir(),
        projectDir: store.getProjectSkillsDir(currentWorkspace),
        currentWorkspace
      };
    }

    case "skills.save": {
      const saved = store.saveSkill(payload.skill, currentWorkspace);
      if (payload.enabled !== undefined) {
        cfg.enabledSkills[saved.id] = Boolean(payload.enabled);
      }
      if (payload.injectionType !== undefined) {
        cfg.directInjections[saved.id] = payload.injectionType === "direct";
      }
      saveConfig(cfg);
      return { ok: true, skill: saved };
    }

    case "skills.toggle": {
      cfg.enabledSkills[payload.id] = Boolean(payload.enabled);
      saveConfig(cfg);
      return { ok: true };
    }

    case "skills.delete": {
      const ok = store.deleteSkill(payload.id, payload.scope, currentWorkspace);
      delete cfg.enabledSkills[payload.id];
      delete cfg.directInjections[payload.id];
      saveConfig(cfg);
      return { ok };
      return { ok };
    }

    case "skills.organize": {
      const globalSkills = store.scanAllGlobalSkills();
      const projectSkills = currentWorkspace 
        ? store.scanSkillsInDir(store.getProjectSkillsDir(currentWorkspace), "project")
        : [];
      const all = [...globalSkills, ...projectSkills];
      let updatedCount = 0;

      const dictionary = {
        "pi-plugin-theme-adaptation": "专用于 PI-Desktop 原生面板：自动适配宿主深浅色主题、零外部网络 CDN 依赖与可靠 IPC 通信。",
        "sparkle-release-workflow": "macOS 客户端 Sparkle 2 更新发版、Ed25519 签名与 CDN 缓存规避标准流程。",
        "find-skills": "技能发现与推荐助手：自动检索并安装适用的技能拓展能力。",
        "skill-creator": "Agent 技能开发与评测助手：专用于从零编写、调试与微调优化全新技能。",
        "skill-forge": "Claude Code 生产级技能锻造大师：精通技能架构设计、提示词工程与触发词精细调优。",
        "skill-review": "技能质量审查与 Lint 专家：审计技能的结构完整性、描述清晰度与流程合理性。",
        "grill-me": "方案严苛拷问与压力测试：全方位质询和完善方案设计，逼出隐藏盲区与边界漏洞。"
      };

      for (const s of all) {
        let clean = (s.desc || "")
          .replace(/\\+"/g, '"')
          .replace(/^["\s\\]+|["\s\\]+$/g, "")
          .trim();

        if (dictionary[s.id]) {
          clean = dictionary[s.id];
        } else if (/^use when\b/i.test(clean) || /^[a-zA-Z\s,.:'-]+$/.test(clean)) {
          clean = clean
            .replace(/^use when authoring\b/i, "用于编写")
            .replace(/^use when releasing\b/i, "用于发版")
            .replace(/^use when\b/i, "专用于")
            .replace(/^a skill for\b/i, "专用于")
            .replace(/\.$/, "。");
          if (!clean.endsWith("。") && !clean.endsWith("！")) clean += "。";
        }

        clean = clean.replace(/\\+"/g, "").replace(/^["']|["']$/g, "").trim();

        if (clean && clean !== s.desc && s.path) {
          const ok = store.updateSkillDescription(s.path, clean);
          if (ok) updatedCount += 1;
        }
      }

      return { ok: true, updatedCount, total: all.length };
    }
    default:
      return { ok: false, error: `unknown channel ${channel}` };
  }
}

async function onLoad(ctx) {
  loadConfig();
  const p = getHostPi() || (ctx && ctx.commands ? ctx : null);

  if (p && p.commands && typeof p.commands.register === "function") {
    try {
      await p.commands.register({
        id: "skill-hub.open",
        title: "Skill Hub: 打开技能工作台",
        keywords: ["skill", "技能", "hub"],
        run: async () => {
          if (p.ui && typeof p.ui.openPanel === "function") {
            await p.ui.openPanel("renderer/index.html");
          }
        }
      });
    } catch {}
  }
}

async function onUnload() {
  const p = getHostPi();
  if (p && p.commands && typeof p.commands.unregister === "function") {
    try {
      await p.commands.unregister("skill-hub.open");
    } catch {}
  }
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  activate: onLoad,
  deactivate: onUnload
};
